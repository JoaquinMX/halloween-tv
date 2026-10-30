/// Owns the live manifest subscription and staged activation lifecycle.
library;

import 'dart:async';
import 'dart:convert';

import 'package:core_playlist/core_playlist.dart';
import 'package:kernel_app/kernel_app.dart';

/// Watches control-plane observations after the verified offline wall is up.
/// A candidate is emitted to playback only after all media is committed, ACK
/// succeeds, and its real playback handle prepares and activates successfully.
final class LiveWallSession {
  LiveWallSession({
    required this.partyId,
    required this.channelId,
    required ManifestSource<PlaybackManifest> manifestSource,
    required PreparePlayback preparation,
    CappedExponentialBackoff? backoff,
  }) : _manifestSource = manifestSource,
       _preparation = preparation,
       _backoff = backoff ?? CappedExponentialBackoff();

  final String partyId;
  final String channelId;
  final ManifestSource<PlaybackManifest> _manifestSource;
  final PreparePlayback _preparation;
  final CappedExponentialBackoff _backoff;
  final StreamController<PlaybackSyncSnapshot> _updates =
      StreamController<PlaybackSyncSnapshot>.broadcast();

  StreamSubscription<PlaybackManifest>? _subscription;
  Timer? _retryTimer;
  PlaybackManifest? _pending;
  PlaybackManifest? _retryManifest;
  Future<void> Function(PlaybackSyncSnapshot)? _activate;
  bool _started = false;
  bool _processing = false;
  bool _disposed = false;
  bool _reconnect = false;
  int _activationFailures = 0;
  int _highestObservedVersion = 0;
  String? _lastActivatedFingerprint;
  String? _lastFailedFingerprint;

  /// Complete versions successfully activated by the TV wall.
  Stream<PlaybackSyncSnapshot> get changes => _updates.stream;

  /// Starts observing after offline boot. [activate] performs actual wall
  /// source preparation and activation through the app-owned handle.
  void start({required Future<void> Function(PlaybackSyncSnapshot) activate}) {
    if (_started || _disposed) return;
    _started = true;
    _activate = activate;
    _listen();
  }

  void _listen() {
    if (_disposed || _subscription != null) return;
    try {
      _subscription = _manifestSource
          .watchCurrent(partyId: partyId, channelId: channelId)
          .listen(
            _observe,
            onError: (Object error, StackTrace stack) => _sourceFailed(error),
            onDone: _sourceClosed,
            cancelOnError: true,
          );
    } on Object catch (error) {
      _sourceFailed(error);
    }
  }

  void _observe(PlaybackManifest manifest) {
    if (_disposed ||
        manifest.partyId != partyId ||
        manifest.channelId != channelId) {
      return;
    }
    final String fingerprint = _fingerprint(manifest);
    if (manifest.version < _highestObservedVersion) return;
    if (manifest.version > _highestObservedVersion) {
      _highestObservedVersion = manifest.version;
      if (_retryManifest != null &&
          _retryManifest!.version < manifest.version) {
        _retryManifest = null;
      }
    }
    if (fingerprint == _lastActivatedFingerprint ||
        fingerprint == _lastFailedFingerprint) {
      return;
    }
    if (_pending != null && _pending!.version > manifest.version) return;
    _pending = manifest;
    _retryTimer?.cancel();
    _retryTimer = null;
    unawaited(_drain());
  }

  Future<void> _drain() async {
    if (_processing || _disposed) return;
    _processing = true;
    try {
      while (!_disposed && _pending != null) {
        final PlaybackManifest manifest = _pending!;
        _pending = null;
        final String fingerprint = _fingerprint(manifest);
        if (fingerprint == _lastActivatedFingerprint) continue;

        final PlaybackSyncSnapshot staged = await _preparation.prepareManifest(
          manifest,
        );
        if (_disposed) return;
        if (staged.state == PlaybackSyncState.ready &&
            staged.hasCompleteMedia &&
            staged.manifest != null &&
            _fingerprint(staged.manifest!) == fingerprint) {
          try {
            await _preparation.activate(
              _SessionPlaybackHandle(
                prepareAction: () async {
                  if (_disposed) throw StateError('live session was disposed');
                },
                activateAction: () async {
                  if (_disposed) throw StateError('live session was disposed');
                  await _activate?.call(staged);
                },
              ),
            );
            if (_disposed) return;
            final PlaybackSyncSnapshot active = _preparation.snapshot;
            if (active.state == PlaybackSyncState.ready &&
                active.hasCompleteMedia &&
                active.manifest != null &&
                _fingerprint(active.manifest!) == fingerprint) {
              _lastActivatedFingerprint = fingerprint;
              _lastFailedFingerprint = null;
              _activationFailures = 0;
              if (!_updates.isClosed) _updates.add(active);
              continue;
            }
          } on Object {
            // Preparation owns the diagnostic state and retry delay.
          }
        }

        final PlaybackSyncSnapshot outcome = _preparation.snapshot;
        if (outcome.state == PlaybackSyncState.errorFatal) {
          _lastFailedFingerprint = fingerprint;
        } else if (outcome.error?.startsWith('playback activation failed:') ==
            true) {
          // Decoder failures are not delivery failures. WallScreen has already
          // rolled changed tiles back; retrying the same version would churn
          // those current decoders again without changing the input bytes.
          _lastFailedFingerprint = fingerprint;
        } else {
          _retryManifest = manifest;
          _activationFailures++;
          _scheduleRetry(
            outcome.retryAfter ?? _backoff.delayFor(_activationFailures),
          );
          if (!_updates.isClosed) _updates.add(outcome);
        }
      }
    } finally {
      _processing = false;
      if (!_disposed && _pending != null) unawaited(_drain());
    }
  }

  void _sourceFailed(Object error) {
    if (_disposed) return;
    _subscription = null;
    _reconnect = true;
    _scheduleRetry(_backoff.delayFor(++_activationFailures));
  }

  void _sourceClosed() {
    if (_disposed) return;
    _subscription = null;
    _reconnect = true;
    _scheduleRetry(_backoff.delayFor(++_activationFailures));
  }

  void _scheduleRetry(Duration delay) {
    if (_disposed) return;
    _retryTimer?.cancel();
    _retryTimer = Timer(delay, () {
      _retryTimer = null;
      if (_disposed) return;
      if (_reconnect) {
        _reconnect = false;
        _listen();
      } else if (_retryManifest case final PlaybackManifest retry) {
        _retryManifest = null;
        _pending ??= retry;
        unawaited(_drain());
      }
    });
  }

  /// Cancels the source, timer, and any in-flight preparation.
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _retryTimer?.cancel();
    _retryTimer = null;
    _preparation.cancel();
    await _subscription?.cancel();
    _subscription = null;
    await _preparation.dispose();
    await _updates.close();
  }

  static String _fingerprint(PlaybackManifest manifest) =>
      jsonEncode(manifest.toJson());
}

/// Small activation handle for the kernel use case. The app wall supplies the
/// actual prepare and activation actions; this adapter carries them through
/// PreparePlayback's stale-operation and lifecycle checks.
final class _SessionPlaybackHandle implements PlaybackHandle {
  _SessionPlaybackHandle({
    required this.prepareAction,
    required this.activateAction,
  });

  final Future<void> Function() prepareAction;
  final Future<void> Function() activateAction;

  @override
  Future<void> prepare() => prepareAction();

  @override
  Future<void> activate() => activateAction();
}
