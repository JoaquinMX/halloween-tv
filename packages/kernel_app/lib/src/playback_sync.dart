/// Playback preparation state and retry policy (Technical Design v1.0 §8.3).
library;

import 'dart:math' as math;

import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';

/// Observable states for boot, version preparation, and recovery.
enum PlaybackSyncState {
  /// Local index and manifests have not been checked yet.
  booting,

  /// A previously committed local version is available for playback.
  usingCache,

  /// A complete new manifest version is being staged.
  preparing,

  /// A verified version is ready for activation or already active.
  ready,

  /// A source, storage, or delivery operation can be retried.
  errorRecoverable,

  /// The manifest violates a domain invariant and must not be retried.
  errorFatal,
}

/// Immutable view of the current playback preparation.
final class PlaybackSyncSnapshot {
  /// Creates a state snapshot.
  PlaybackSyncSnapshot({
    required this.state,
    this.manifest,
    Map<String, CachedMedia> mediaByClipId = const <String, CachedMedia>{},
    this.error,
    this.retryAfter,
  }) : mediaByClipId = Map<String, CachedMedia>.unmodifiable(mediaByClipId);

  /// Current state.
  final PlaybackSyncState state;

  /// Complete manifest retained for this snapshot, when available.
  final PlaybackManifest? manifest;

  /// Verified local entries keyed by manifest clip id.
  final Map<String, CachedMedia> mediaByClipId;

  /// Human-readable failure detail, or null when there is no error.
  final String? error;

  /// Capped, jittered delay before retrying a recoverable failure.
  final Duration? retryAfter;

  /// Whether this snapshot can keep existing playback available.
  bool get hasCompleteMedia =>
      manifest != null && mediaByClipId.length == manifest!.clips.length;
}

/// Full-jitter exponential delay with an explicit maximum ceiling.
final class CappedExponentialBackoff {
  /// Creates a retry policy.
  CappedExponentialBackoff({
    this.initialDelay = const Duration(milliseconds: 500),
    this.maxDelay = const Duration(seconds: 30),
    double Function()? randomUnit,
  }) : _randomUnit = randomUnit ?? math.Random().nextDouble {
    if (initialDelay.isNegative || initialDelay == Duration.zero) {
      throw ArgumentError.value(
        initialDelay,
        'initialDelay',
        'must be positive',
      );
    }
    if (maxDelay < initialDelay) {
      throw ArgumentError.value(
        maxDelay,
        'maxDelay',
        'must be >= initialDelay',
      );
    }
  }

  /// First retry ceiling.
  final Duration initialDelay;

  /// Maximum retry ceiling.
  final Duration maxDelay;

  final double Function() _randomUnit;

  /// Computes a full-jitter delay for one-based [failedAttempt].
  Duration delayFor(int failedAttempt) {
    if (failedAttempt <= 0) {
      throw ArgumentError.value(failedAttempt, 'failedAttempt', 'must be > 0');
    }
    var ceilingMs = initialDelay.inMilliseconds;
    for (var attempt = 1; attempt < failedAttempt; attempt++) {
      ceilingMs = math.min<int>(ceilingMs * 2, maxDelay.inMilliseconds);
      if (ceilingMs == maxDelay.inMilliseconds) {
        break;
      }
    }
    final double random = _randomUnit();
    if (!random.isFinite || random < 0 || random > 1) {
      throw StateError('randomUnit must return a value in 0..1');
    }
    return Duration(milliseconds: (ceilingMs * random).floor());
  }
}
