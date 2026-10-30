/// Lifecycle-safe anonymous guest session.
///
/// Joins ONLY on a valid scoped manifest response from the
/// [ManifestSource]<[PlaybackManifest]> port (contracts layer,
/// `package:channel_api`). This file depends on the port — never on a
/// concrete connection class and never on Firebase.
///
/// Rules enforced here:
/// - Last-known metadata lives in memory only and is labeled
///   [GuestSessionStatus.stale] after transient failures or suspension; a
///   cold offline start surfaces [GuestSessionStatus.unavailable] with no
///   fabricated manifest.
/// - [leave] (and change-party via [join]) clears identity, metadata, and
///   timestamps. `FORBIDDEN`/`UNAUTHENTICATED` clears inaccessible data;
///   `CLIP_EXPIRED` is never labeled current.
/// - Subscriptions are cancelled on leave/dispose/background; [resume]
///   performs a fresh read. Concurrent [refresh] calls never overlap, and
///   late responses from superseded sessions (party-switch races) are
///   ignored via a generation counter.
library;

import 'dart:async';
import 'dart:developer' as developer;

import 'package:channel_api/channel_api.dart';
import 'package:companion_app/src/data/manifest_failure.dart';
import 'package:companion_app/src/data/party_join_client.dart';
import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:companion_app/src/session/guest_session_state.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';

/// Anonymous guest session bound to one party/device/channel at a time.
final class GuestSession {
  /// Creates a session reading manifests from [source].
  ///
  /// [clock] supplies [GuestSessionState.lastSuccessfulCheck] timestamps so
  /// tests can observe unchanged-version reads deterministically.
  GuestSession({
    required ManifestSource<PlaybackManifest> source,
    required Clock clock,
    PartyJoinClient? joinClient,
  }) : _source = source,
       _clock = clock,
       _joinClient = joinClient;

  final ManifestSource<PlaybackManifest> _source;
  final Clock _clock;
  final PartyJoinClient? _joinClient;

  final StreamController<GuestSessionState> _states =
      StreamController<GuestSessionState>.broadcast();

  GuestSessionState _state = const GuestSessionState.idle();

  /// Current immutable snapshot.
  GuestSessionState get state => _state;

  /// Broadcast of state snapshots.
  Stream<GuestSessionState> get states => _states.stream;

  /// Bound identity, or `null` when idle.
  GuestJoinData? get joinData => _state.join;

  /// Current or last-known manifest, or `null` when none is retained.
  PlaybackManifest? get manifest => _state.manifest;

  StreamSubscription<PlaybackManifest>? _subscription;

  /// Generation counter: incremented on every [join], [leave], [suspend],
  /// [resume], and [dispose] so late events from a superseded subscription
  /// can never mutate the new session.
  int _generation = 0;

  /// Guards [refresh] (and [resume] reads) against overlap.
  bool _refreshing = false;
  bool _registered = false;
  bool _disposed = false;

  void _emit(GuestSessionState next) {
    _state = next;
    if (!_states.isClosed) {
      _states.add(next);
    }
  }

  Future<void> _cancelSubscription() async {
    final StreamSubscription<PlaybackManifest>? sub = _subscription;
    _subscription = null;
    if (sub != null) {
      await sub.cancel();
    }
  }

  /// Joins as [data], replacing any previous session.
  ///
  /// A previous identity (change-party) is fully cleared before the new
  /// loading state is emitted, so a party switch never leaks the old
  /// party's metadata. Late responses from the superseded subscription are
  /// ignored. The join completes (as ready/denied/expired/unavailable/
  /// invalid-data) only when the [ManifestSource] port responds.
  Future<void> join(GuestJoinData data) async {
    if (_disposed) {
      return;
    }
    _generation++;
    final int generation = _generation;
    await _cancelSubscription();
    if (generation != _generation || _disposed) {
      return;
    }
    _refreshing = false;
    _registered = false;
    _emit(
      GuestSessionState(
        status: GuestSessionStatus.loading,
        join: data,
        message: 'Joining ${data.partyId.value}/${data.channelId}',
      ),
    );
    final PartyJoinClient? client = _joinClient;
    if (client != null) {
      try {
        await client.register(
          partyId: data.partyId.value,
          deviceId: data.deviceId.value,
          channelId: data.channelId,
        );
      } on Object catch (error) {
        if (generation == _generation && !_disposed) {
          _handleError(error, generation);
        }
        return;
      }
      if (generation != _generation || _disposed) return;
      _registered = true;
    }
    _subscribe(data, generation);
  }

  void _subscribe(GuestJoinData data, int generation) {
    late final Stream<PlaybackManifest> stream;
    try {
      stream = _source.watchCurrent(
        partyId: data.partyId.value,
        channelId: data.channelId,
      );
    } on Object catch (error) {
      if (generation == _generation) {
        _handleError(error, generation);
      }
      return;
    }
    _subscription = stream.listen(
      (PlaybackManifest manifest) {
        if (generation == _generation) {
          _handleManifest(manifest, generation);
        }
      },
      onError: (Object error) {
        if (generation == _generation) {
          _handleError(error, generation);
        }
      },
      onDone: () {
        if (generation != _generation) {
          return;
        }
        // An ended stream without data is only terminal when nothing is
        // retained; otherwise keep showing last-known metadata as stale.
        if (_state.manifest == null &&
            _state.status == GuestSessionStatus.loading) {
          _emit(
            _state.copyWith(
              status: GuestSessionStatus.unavailable,
              message: 'Manifest stream ended without data',
            ),
          );
        }
      },
      cancelOnError: false,
    );
  }

  void _handleManifest(PlaybackManifest manifest, int generation) {
    if (generation != _generation || _disposed) {
      return;
    }
    final GuestJoinData? bound = _state.join;
    if (bound == null) {
      return;
    }
    // Scope check: the response must belong to the requested party/channel.
    if (manifest.partyId != bound.partyId.value ||
        manifest.channelId != bound.channelId) {
      _emit(
        GuestSessionState(
          status: GuestSessionStatus.invalidData,
          join: bound,
          message:
              'Manifest scope mismatch: requested '
              '${bound.partyId.value}/${bound.channelId} but received '
              '${manifest.partyId}/${manifest.channelId}',
        ),
      );
      return;
    }
    final Result<PlaybackManifest> validated = validateCctvManifest(manifest);
    if (validated is Err<PlaybackManifest>) {
      // Validator detail is app-generated diagnostics, not UI text: the raw
      // reason stays in logs and the UI only gets the fixed message.
      developer.log(
        'GuestSession manifest validation failed: ${validated.message}',
        name: 'companion.guest_session',
      );
      _emit(
        GuestSessionState(
          status: GuestSessionStatus.invalidData,
          join: bound,
          message: 'The manifest data was invalid.',
        ),
      );
      return;
    }
    // Valid scoped manifest — current, even when the version is unchanged.
    // Re-observations of the same version refresh the check timestamp.
    _emit(
      GuestSessionState(
        status: GuestSessionStatus.ready,
        join: bound,
        manifest: manifest,
        lastSuccessfulCheck: _clock.now(),
      ),
    );
  }

  /// Classifies stream errors structurally and maps them to statuses.
  ///
  /// Classification is structural only: [ManifestFailure.classify] unwraps
  /// transport cause chains and reads the backend `details.errorCode`
  /// contract codes (plus SDK codes and typed schema/scope/format errors).
  /// There is deliberately NO substring matching on `error.toString()`:
  /// raw SDK/backend text never reaches [GuestSessionState.message] — it
  /// stays in logs only, and the UI renders fixed [ManifestFailure] text.
  ///
  /// Kind mapping: `FORBIDDEN`/`UNAUTHENTICATED` clear inaccessible data as
  /// [GuestSessionStatus.denied]; `CLIP_EXPIRED` is never labeled current
  /// ([GuestSessionStatus.expired]); `MANIFEST_MISMATCH` and other malformed
  /// payloads surface as [GuestSessionStatus.invalidData] (retryable false);
  /// `NOT_FOUND` surfaces the no-manifest state (cold: unavailable,
  /// retained: stale); transport/unavailable/timeout failures retain
  /// last-known metadata as stale, or report unavailable on a cold start.
  void _handleError(Object error, int generation) {
    if (generation != _generation || _disposed) {
      return;
    }
    final GuestJoinData? bound = _state.join;
    if (bound == null) {
      return;
    }
    developer.log(
      'GuestSession stream error: $error',
      name: 'companion.guest_session',
    );
    final ManifestFailure failure = ManifestFailure.classify(error);
    switch (failure.kind) {
      case ManifestFailureKind.forbidden:
      case ManifestFailureKind.unauthenticated:
        // Inaccessible data is cleared; the binding is kept so the UI can
        // explain which party was rejected.
        _emit(
          GuestSessionState(
            status: GuestSessionStatus.denied,
            join: bound,
            message: failure.message,
          ),
        );
        return;
      case ManifestFailureKind.expired:
        // Expiry is never labeled current: drop any retained metadata.
        _emit(
          GuestSessionState(
            status: GuestSessionStatus.expired,
            join: bound,
            message: failure.message,
          ),
        );
        return;
      case ManifestFailureKind.malformed:
      case ManifestFailureKind.invalidArgument:
      case ManifestFailureKind.configuration:
        _emit(
          GuestSessionState(
            status: GuestSessionStatus.invalidData,
            join: bound,
            message: failure.message,
          ),
        );
        return;
      case ManifestFailureKind.notFound:
      case ManifestFailureKind.unavailable:
      case ManifestFailureKind.transport:
      case ManifestFailureKind.timeout:
        break;
    }
    // No-manifest and transient failures: retain last-known metadata as
    // stale, or report unavailable on a cold start with nothing retained.
    final PlaybackManifest? retained = _state.manifest;
    if (retained != null) {
      _emit(
        GuestSessionState(
          status: GuestSessionStatus.stale,
          join: bound,
          manifest: retained,
          message: failure.message,
          lastSuccessfulCheck: _state.lastSuccessfulCheck,
        ),
      );
      return;
    }
    _emit(
      GuestSessionState(
        status: GuestSessionStatus.unavailable,
        join: bound,
        message: failure.message,
      ),
    );
  }

  /// Re-reads the current manifest without overlapping in-flight refreshes.
  ///
  /// Concurrent calls while a refresh is already running are ignored.
  Future<void> refresh() async {
    if (_disposed || _refreshing) {
      return;
    }
    final GuestJoinData? bound = _state.join;
    if (bound == null) {
      return;
    }
    if (_joinClient != null && !_registered) {
      await join(bound);
      return;
    }
    _refreshing = true;
    _generation++;
    final int generation = _generation;
    try {
      await _cancelSubscription();
      if (generation != _generation || _disposed) {
        return;
      }
      final PlaybackManifest? retained = _state.manifest;
      _emit(
        GuestSessionState(
          status: GuestSessionStatus.loading,
          join: bound,
          manifest: retained,
          message: 'Refreshing ${bound.partyId.value}/${bound.channelId}',
          lastSuccessfulCheck: _state.lastSuccessfulCheck,
        ),
      );
      _subscribe(bound, generation);
    } finally {
      _refreshing = false;
    }
  }

  /// Suspends the session for backgrounding: cancels the subscription and
  /// labels retained metadata stale. A session with no retained manifest
  /// keeps its join binding (including while still loading, so a
  /// backgrounded cold start re-subscribes on resume instead of resetting
  /// to idle and discarding the typed identifiers).
  Future<void> suspend() async {
    if (_disposed) {
      return;
    }
    _generation++;
    await _cancelSubscription();
    _refreshing = false;
    final GuestJoinData? bound = _state.join;
    if (bound == null) {
      return;
    }
    final PlaybackManifest? retained = _state.manifest;
    if (retained != null) {
      _emit(
        GuestSessionState(
          status: GuestSessionStatus.stale,
          join: bound,
          manifest: retained,
          message: 'Suspended; showing last-known data',
          lastSuccessfulCheck: _state.lastSuccessfulCheck,
        ),
      );
      return;
    }
    if (_state.status == GuestSessionStatus.loading) {
      _emit(
        GuestSessionState(
          status: GuestSessionStatus.loading,
          join: bound,
          message: 'Suspended before first manifest; will retry on resume',
          lastSuccessfulCheck: _state.lastSuccessfulCheck,
        ),
      );
    }
    // Settled non-loading states without retained metadata (denied,
    // expired, invalid-data, unavailable) keep their binding and message;
    // the subscription is already cancelled above.
  }

  /// Resumes the session with a fresh read after [suspend].
  ///
  /// No-op when no identity is bound.
  Future<void> resume() async {
    if (_disposed || _refreshing) {
      return;
    }
    final GuestJoinData? bound = _state.join;
    if (bound == null) {
      return;
    }
    if (_joinClient != null && !_registered) {
      await join(bound);
      return;
    }
    // A fresh generation both ignores late events from the suspended
    // subscription and guards against overlapping resume/refresh calls.
    _refreshing = true;
    _generation++;
    final int generation = _generation;
    try {
      await _cancelSubscription();
      if (generation != _generation || _disposed) {
        return;
      }
      _emit(
        GuestSessionState(
          status: GuestSessionStatus.loading,
          join: bound,
          manifest: _state.manifest,
          message: 'Resuming ${bound.partyId.value}/${bound.channelId}',
          lastSuccessfulCheck: _state.lastSuccessfulCheck,
        ),
      );
      _subscribe(bound, generation);
    } finally {
      _refreshing = false;
    }
  }

  /// Leaves the party: cancels the subscription and clears identity,
  /// metadata, and timestamps.
  Future<void> leave() async {
    _generation++;
    await _cancelSubscription();
    _refreshing = false;
    if (_disposed) {
      return;
    }
    _emit(const GuestSessionState.idle());
  }

  /// Releases the subscription and the state broadcast.
  Future<void> dispose() async {
    if (_disposed) {
      return;
    }
    _disposed = true;
    _generation++;
    await _cancelSubscription();
    if (!_states.isClosed) {
      await _states.close();
    }
  }
}
