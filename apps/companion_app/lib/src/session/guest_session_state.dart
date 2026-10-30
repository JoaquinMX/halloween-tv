/// Explicit lifecycle states for the anonymous guest session.
///
/// The session moves through these states only; there is no implicit
/// "connected" flag. `stale` doubles as the offline marker: last-known
/// metadata is retained in memory and labeled stale after transient
/// failures or suspension, while a cold offline start (no manifest yet)
/// surfaces as [GuestSessionStatus.unavailable] with no fabricated data.
library;

import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:core_playlist/core_playlist.dart';

/// Lifecycle status of [GuestSessionState].
enum GuestSessionStatus {
  /// No identity bound; no subscription active.
  idle,

  /// Waiting for the first (or next fresh) scoped manifest response.
  loading,

  /// A valid scoped manifest is current.
  ready,

  /// Stale/offline: last-known manifest retained after a transient failure
  /// or suspension; never used for a cold start.
  stale,

  /// Cold start with no manifest and no usable transport (offline on first
  /// read). Carries no fabricated manifest.
  unavailable,

  /// Server rejected the binding (`FORBIDDEN`/`UNAUTHENTICATED`).
  /// Inaccessible data has been cleared.
  denied,

  /// Server reported expiry (`CLIP_EXPIRED`). Never labeled current.
  expired,

  /// The transport delivered unscoped or malformed data.
  invalidData,
}

/// Immutable snapshot of the guest session.
final class GuestSessionState {
  /// Current lifecycle status.
  final GuestSessionStatus status;

  /// Bound anonymous identity, or `null` after [GuestSessionStatus.idle].
  final GuestJoinData? join;

  /// Last-known manifest. Non-null only in [GuestSessionStatus.ready] and
  /// [GuestSessionStatus.stale]; every other status carries `null`.
  final PlaybackManifest? manifest;

  /// Human-readable detail for the current status (never executable).
  final String? message;

  /// Time of the last successful scoped manifest observation, recorded via
  /// the injected [Clock]. Updated even when the observed version is
  /// unchanged. `null` until the first success and after leave.
  final DateTime? lastSuccessfulCheck;

  const GuestSessionState({
    required this.status,
    this.join,
    this.manifest,
    this.message,
    this.lastSuccessfulCheck,
  });

  /// Idle snapshot with no identity, metadata, or timestamps.
  const GuestSessionState.idle() : this(status: GuestSessionStatus.idle);

  /// Returns a copy with the given fields replaced.
  GuestSessionState copyWith({
    GuestSessionStatus? status,
    GuestJoinData? join,
    PlaybackManifest? manifest,
    String? message,
    DateTime? lastSuccessfulCheck,
    bool clearJoin = false,
    bool clearManifest = false,
    bool clearMessage = false,
    bool clearLastSuccessfulCheck = false,
  }) {
    return GuestSessionState(
      status: status ?? this.status,
      join: clearJoin ? null : (join ?? this.join),
      manifest: clearManifest ? null : (manifest ?? this.manifest),
      message: clearMessage ? null : (message ?? this.message),
      lastSuccessfulCheck: clearLastSuccessfulCheck
          ? null
          : (lastSuccessfulCheck ?? this.lastSuccessfulCheck),
    );
  }

  /// True when a current manifest is available.
  bool get isReady => status == GuestSessionStatus.ready && manifest != null;

  /// True when showing retained last-known metadata while offline.
  bool get isStale => status == GuestSessionStatus.stale && manifest != null;

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) {
      return true;
    }
    return other is GuestSessionState &&
        other.status == status &&
        other.join == join &&
        other.manifest == manifest &&
        other.message == message &&
        other.lastSuccessfulCheck == lastSuccessfulCheck;
  }

  @override
  int get hashCode =>
      Object.hash(status, join, manifest, message, lastSuccessfulCheck);

  @override
  String toString() =>
      'GuestSessionState($status, manifest: ${manifest?.version}, '
      'checked: $lastSuccessfulCheck)';
}
