/// Lifecycle-safe host administration session.
///
/// Joins ONLY through [HostJoinClient.redeem] (the `joinHost` callable) and
/// administers the seed catalog ONLY through [HostMediaClient]. This file
/// depends on the two callable-boundary ports — never on a concrete
/// connection class and never on Firebase.
///
/// Rules enforced here:
/// - The bound identity is a host payload ([GuestJoinData] with
///   [JoinRole.host]); guest payloads are rejected before any callable.
/// - [join] validates the returned party/channel/device/host scope (via the
///   client) before the session becomes ready; denials surface as
///   [HostSessionStatus.denied] and throw a sanitized [HostJoinException]
///   so the entry screen can fail visibly without entering the panel.
/// - `generateHostVideo` uses a stable idempotency key per seed id: retries
///   of the same seed reuse the queued job (`created: false`) instead of
///   enqueueing another task.
/// - [deleteVideos] reconciles the list only after authoritative success;
///   failures leave local state untouched so they stay retryable.
/// - A generation counter keeps late responses from a superseded
///   join/refresh/poll (party switches, background suspend, leave, dispose)
///   from mutating the new session. Polling stops on [suspend], [leave],
///   and [dispose].
library;

import 'dart:async';
import 'dart:developer' as developer;
import 'dart:math';

import 'package:companion_app/src/data/host_join_client.dart';
import 'package:companion_app/src/data/host_media_client.dart';
import 'package:companion_app/src/data/manifest_failure.dart';
import 'package:companion_app/src/join/guest_join_data.dart';

/// Lifecycle status of [HostSessionState].
enum HostSessionStatus {
  /// No host identity bound; no polling active.
  idle,

  /// Redeeming the host invite / loading the seed catalog.
  loading,

  /// A validated host binding with a current seed catalog.
  ready,

  /// Stale: retained catalog after a transient failure or suspension.
  stale,

  /// Cold start with no catalog and no usable transport.
  unavailable,

  /// The server rejected the binding (`FORBIDDEN`/`UNAUTHENTICATED`).
  denied,

  /// The invite or catalog data was invalid.
  invalidData,
}

/// Immutable snapshot of the host session.
final class HostSessionState {
  const HostSessionState({
    required this.status,
    this.binding,
    this.videos = const <HostSeedVideo>[],
    this.message,
  });

  const HostSessionState.idle() : this(status: HostSessionStatus.idle);

  final HostSessionStatus status;
  final GuestJoinData? binding;
  final List<HostSeedVideo> videos;
  final String? message;

  HostSessionState copyWith({
    HostSessionStatus? status,
    GuestJoinData? binding,
    List<HostSeedVideo>? videos,
    String? message,
  }) => HostSessionState(
    status: status ?? this.status,
    binding: binding ?? this.binding,
    videos: videos ?? this.videos,
    message: message ?? this.message,
  );

  @override
  bool operator ==(Object other) =>
      other is HostSessionState &&
      other.status == status &&
      other.binding == binding &&
      other.message == message &&
      _videoIds(other.videos).join(',') == _videoIds(videos).join(',');

  @override
  int get hashCode => Object.hash(status, binding, message, videos.length);

  @override
  String toString() => 'HostSessionState($status, videos: ${videos.length})';

  static List<String> _videoIds(List<HostSeedVideo> videos) => <String>[
    for (final HostSeedVideo v in videos) '${v.seedId}:${v.status}',
  ];
}

/// Sanitized host-join failure for the entry screen.
///
/// Carries only the fixed user-presentable message (never raw backend
/// detail); [toString] returns the message itself.
final class HostJoinException implements Exception {
  const HostJoinException(this.message);
  final String message;

  @override
  String toString() => message;
}

/// Host administration session bound to one party/device/channel at a time.
final class HostSession {
  HostSession({
    required HostJoinClient joinClient,
    required HostMediaClient mediaClient,
    Duration pollInterval = const Duration(seconds: 15),
    Random? random,
  }) : _joinClient = joinClient,
       _mediaClient = mediaClient,
       _pollInterval = pollInterval,
       _random = random ?? Random.secure();

  final HostJoinClient _joinClient;
  final HostMediaClient _mediaClient;
  final Duration _pollInterval;
  final Random _random;

  final StreamController<HostSessionState> _states =
      StreamController<HostSessionState>.broadcast();

  HostSessionState _state = const HostSessionState.idle();

  /// Current immutable snapshot.
  HostSessionState get state => _state;

  /// Broadcast of state snapshots.
  Stream<HostSessionState> get states => _states.stream;

  /// Bound host identity, or `null` when idle.
  GuestJoinData? get binding => _state.binding;

  /// Current or last-known seed catalog.
  List<HostSeedVideo> get videos =>
      List<HostSeedVideo>.unmodifiable(_state.videos);

  int _generation = 0;
  bool _disposed = false;
  bool _busy = false;
  Timer? _pollTimer;

  /// Stable idempotency keys per seed id (retries reuse the queued job).
  final Map<String, String> _idempotencyKeys = <String, String>{};

  void _emit(HostSessionState next) {
    _state = next;
    if (!_states.isClosed) {
      _states.add(next);
    }
  }

  String _mintIdempotencyKey() {
    final List<int> bytes = List<int>.generate(16, (_) => _random.nextInt(256));
    return bytes.map((int b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  /// Joins as a host [data], replacing any previous session.
  ///
  /// Throws a sanitized [HostJoinException] when the invite cannot be
  /// redeemed (the emitted state carries the same fixed message). Guest
  /// payloads are rejected before any network call.
  ///
  /// The 6-digit [pairingCode] shown next to the Host QR is forwarded to
  /// [HostJoinClient.redeem] (server `joinHost` requires it); a missing code
  /// preserves the legacy call shape and the server denies generically.
  /// The code is never logged.
  Future<void> join(GuestJoinData data, {String? pairingCode}) async {
    if (_disposed) return;
    if (data.role != JoinRole.host || data.inviteToken == null) {
      throw const HostJoinException(
        'This host entry needs a host invitation. Join as a guest instead.',
      );
    }
    _generation++;
    final int generation = _generation;
    _stopPolling();
    _busy = false;
    _emit(
      HostSessionState(
        status: HostSessionStatus.loading,
        binding: data,
        message: 'Redeeming host invite for ${data.partyId.value}',
      ),
    );
    try {
      await _joinClient.redeem(
        partyId: data.partyId.value,
        deviceId: data.deviceId.value,
        channelId: data.channelId,
        inviteToken: data.inviteToken!,
        pairingCode: pairingCode,
      );
    } on Object catch (error) {
      if (generation == _generation && !_disposed) {
        final ManifestFailure failure = error is ManifestFailure
            ? error
            : ManifestFailure.classify(error);
        developer.log(
          'HostSession join failed: $error',
          name: 'companion.host_session',
        );
        final HostSessionStatus status = switch (failure.kind) {
          ManifestFailureKind.forbidden ||
          ManifestFailureKind.unauthenticated => HostSessionStatus.denied,
          ManifestFailureKind.invalidArgument ||
          ManifestFailureKind.malformed ||
          ManifestFailureKind.configuration => HostSessionStatus.invalidData,
          _ => HostSessionStatus.unavailable,
        };
        _emit(
          HostSessionState(
            status: status,
            binding: data,
            message: failure.message,
          ),
        );
        throw HostJoinException(failure.message);
      }
      throw const HostJoinException('Could not reach the backend.');
    }
    if (generation != _generation || _disposed) return;
    await _loadCatalog(data, generation);
    if (generation != _generation || _disposed) return;
    _startPolling();
  }

  Future<void> _loadCatalog(GuestJoinData data, int generation) async {
    try {
      final List<HostSeedVideo> listed = await _mediaClient.listVideos(
        partyId: data.partyId.value,
        deviceId: data.deviceId.value,
        channelId: data.channelId,
      );
      if (generation != _generation || _disposed) return;
      _emit(
        HostSessionState(
          status: HostSessionStatus.ready,
          binding: data,
          videos: listed,
        ),
      );
    } on Object catch (error) {
      if (generation != _generation || _disposed) return;
      developer.log(
        'HostSession catalog load failed: $error',
        name: 'companion.host_session',
      );
      final ManifestFailure failure = ManifestFailure.classify(error);
      if (_state.videos.isNotEmpty) {
        _emit(
          HostSessionState(
            status: HostSessionStatus.stale,
            binding: data,
            videos: _state.videos,
            message: failure.message,
          ),
        );
        return;
      }
      _emit(
        HostSessionState(
          status: HostSessionStatus.unavailable,
          binding: data,
          message: failure.message,
        ),
      );
    }
  }

  /// Refreshes the seed catalog without overlapping in-flight work.
  Future<void> refresh() async {
    if (_disposed || _busy) return;
    final GuestJoinData? bound = _state.binding;
    if (bound == null || _state.status == HostSessionStatus.idle) return;
    _busy = true;
    _generation++;
    final int generation = _generation;
    try {
      await _loadCatalog(bound, generation);
    } finally {
      _busy = false;
    }
  }

  /// Enqueues fixed-preset generation for [seedId].
  ///
  /// The idempotency key is stable per seed id: retries reuse the queued
  /// job (`created: false`) instead of enqueueing another task. Returns the
  /// server result. Failures throw and leave local state untouched.
  Future<Map<String, Object?>> generate(
    String seedId, {
    String presetId = kCheapDemoPresetId,
    String? guestMediaId,
  }) async {
    final GuestJoinData? bound = _state.binding;
    if (bound == null || _disposed) {
      throw StateError('Join as host before generating video');
    }
    final String key = _idempotencyKeys.putIfAbsent(
      seedId,
      _mintIdempotencyKey,
    );
    final Map<String, Object?> result = await _mediaClient.generateVideo(
      partyId: bound.partyId.value,
      deviceId: bound.deviceId.value,
      channelId: bound.channelId,
      seedId: seedId,
      idempotencyKey: key,
      presetId: presetId,
      guestMediaId: guestMediaId,
    );
    await refresh();
    return result;
  }

  /// Obtains a fresh scoped preview capability for [seedId].
  ///
  /// Every view requests a new capability: signed URLs are short-lived and
  /// never persisted.
  Future<HostVideoPreview> preview(String seedId) {
    final GuestJoinData? bound = _state.binding;
    if (bound == null || _disposed) {
      throw StateError('Join as host before previewing video');
    }
    return _mediaClient.getPreview(
      partyId: bound.partyId.value,
      deviceId: bound.deviceId.value,
      channelId: bound.channelId,
      seedId: seedId,
    );
  }

  /// Deletes [seedIds] and reconciles the list after authoritative success.
  ///
  /// Failures throw and leave the local list untouched so they stay
  /// retryable.
  Future<Map<String, Object?>> deleteVideos(List<String> seedIds) async {
    final GuestJoinData? bound = _state.binding;
    if (bound == null || _disposed) {
      throw StateError('Join as host before deleting video');
    }
    final Map<String, Object?> result = await _mediaClient.deleteVideos(
      partyId: bound.partyId.value,
      deviceId: bound.deviceId.value,
      channelId: bound.channelId,
      seedIds: seedIds,
    );
    await refresh();
    return result;
  }

  void _startPolling() {
    _stopPolling();
    if (_disposed) return;
    _pollTimer = Timer.periodic(_pollInterval, (_) {
      unawaited(refresh());
    });
  }

  void _stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  /// Suspends polling for backgrounding; the retained catalog stays
  /// readable as the current snapshot.
  Future<void> suspend() async {
    if (_disposed) return;
    _generation++;
    _stopPolling();
    _busy = false;
    final GuestJoinData? bound = _state.binding;
    if (bound == null) return;
    if (_state.videos.isNotEmpty && _state.status == HostSessionStatus.ready) {
      _emit(
        HostSessionState(
          status: HostSessionStatus.stale,
          binding: bound,
          videos: _state.videos,
          message: 'Suspended; showing last-known catalog',
        ),
      );
    }
  }

  /// Resumes polling with a fresh catalog read after [suspend].
  Future<void> resume() async {
    if (_disposed) return;
    final GuestJoinData? bound = _state.binding;
    if (bound == null || _state.status == HostSessionStatus.idle) return;
    _startPolling();
    await refresh();
  }

  /// Leaves the host session: stops polling and clears identity + catalog.
  Future<void> leave() async {
    _generation++;
    _stopPolling();
    _busy = false;
    _idempotencyKeys.clear();
    if (_disposed) return;
    _emit(const HostSessionState.idle());
  }

  /// Releases polling and the state broadcast.
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    _stopPolling();
    if (!_states.isClosed) {
      await _states.close();
    }
  }
}
