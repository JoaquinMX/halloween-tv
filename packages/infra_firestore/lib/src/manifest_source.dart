/// Firestore control-plane stubs: manifest source port + document mapping.
///
/// Design authority: Technical Design v1.0 §9 (Firestore control plane).
/// Interfaces ONLY — zero network calls, zero firebase SDK imports.
///
/// Every type crossing this boundary belongs to `core_playlist`
/// ([PlaybackManifest], [ClipDescriptor], [OverlaySettings]) or
/// `core_foundation`; nothing is redefined here.
library;

import 'package:core_playlist/core_playlist.dart';

/// Supported Firestore manifest document schema version.
///
/// Bump when the wire shape changes; [manifestFromFirestore] rejects any
/// other version so a stale client never plays a manifest it cannot parse.
const int kManifestSchemaVersion = 1;

/// Thrown when a Firestore document cannot be mapped to a manifest, e.g.
/// an unsupported `schemaVersion` or a malformed payload.
class ManifestSchemaException implements Exception {
  /// Creates a schema violation error with a human-readable [message].
  const ManifestSchemaException(this.message);

  /// Human-readable description of the violation.
  final String message;

  @override
  String toString() => 'ManifestSchemaException: $message';
}

/// Abstract control-plane source for the currently-scheduled manifest.
///
/// Production implementation watches
/// `parties/{partyId}/channels/{channelId}/current` via Firestore snapshot
/// listeners and maps each document with [manifestFromFirestore]. This
/// slice ships the port plus a static fixture source.
abstract interface class ManifestSource {
  /// Streams the current [PlaybackManifest] for a party channel.
  ///
  /// Emits a new manifest whenever the control plane publishes one. The
  /// stream owns no sockets in this slice; implementations that do must
  /// keep `dart:io` out of this signature.
  Stream<PlaybackManifest> watchCurrent({
    required String partyId,
    required String channelId,
  });
}

/// Fixture-backed [ManifestSource] that emits [fixture] once per
/// subscription and then closes.
///
/// Used by tests, previews, and offline playback. In stub mode the fixture
/// is authoritative for every requested party/channel, so callers can wire
/// the port before the control plane exists.
class StaticManifestSource implements ManifestSource {
  /// Creates a source that emits [fixture] once per subscription.
  const StaticManifestSource(this.fixture);

  /// The manifest emitted to every subscriber.
  final PlaybackManifest fixture;

  @override
  Stream<PlaybackManifest> watchCurrent({
    required String partyId,
    required String channelId,
  }) async* {
    yield fixture;
  }
}

/// Maps a Firestore document snapshot to a [PlaybackManifest].
///
/// Expected fixture JSON shape (same as `PlaybackManifest.toJson` plus the
/// envelope field `schemaVersion`):
/// ```json
/// {
///   "schemaVersion": 1,
///   "partyId": "party-1",
///   "channelId": "cctv",
///   "version": 1,
///   "publishedAt": "2026-10-29T00:00:00.000Z",
///   "overlay": {"scanlineOpacity": 0.5, "noiseLevel": 0.2, "vignette": 0.6},
///   "clips": [
///     {
///       "id": "clip-1",
///       "cameraId": "CAM-01",
///       "storageObjectId": "cctv/cam-01.mp4",
///       "sha256": "<64 hex chars>",
///       "sizeBytes": 1024,
///       "durationMs": 8000,
///       "mimeType": "video/mp4"
///     }
///   ]
/// }
/// ```
///
/// Tolerance rules:
/// - `schemaVersion` accepts `1`, `1.0`, or `"1"` (whitespace trimmed);
///   missing, fractional, or any other value throws
///   [ManifestSchemaException].
/// - Unknown top-level, overlay, and per-clip fields are ignored
///   (forward compat) — only the fields above are read.
/// - Structural problems in the remaining payload surface as
///   [ManifestSchemaException], never as raw `FormatException` /
///   `TypeError`.
///
/// Semantic rules (4 CCTV cameras, digests, durations) live in
/// `core_playlist`'s `validateCctvManifest`; mapping stays shape-only so it
/// can also carry manifests for non-CCTV channels.
PlaybackManifest manifestFromFirestore(Map<String, Object?> doc) {
  final version = _schemaVersionOf(doc['schemaVersion']);
  if (version != kManifestSchemaVersion) {
    throw ManifestSchemaException(
      'unsupported schemaVersion: $version '
      '(expected $kManifestSchemaVersion)',
    );
  }

  // Drop the envelope field; the rest is the manifest payload, which
  // core_playlist owns. Copying keeps the caller's map untouched.
  final payload = <String, Object?>{...doc}..remove('schemaVersion');
  try {
    return parseManifest(payload);
  } on FormatException catch (error) {
    throw ManifestSchemaException('invalid manifest payload: ${error.message}');
  }
}

int _schemaVersionOf(Object? raw) {
  if (raw is int) {
    return raw;
  }
  final parsed = switch (raw) {
    final num v when v == v.truncateToDouble() => v.toInt(),
    final String v => int.tryParse(v.trim()),
    _ => null,
  };
  if (parsed == null) {
    throw ManifestSchemaException(
      'missing or invalid schemaVersion: $raw '
      '(expected $kManifestSchemaVersion)',
    );
  }
  return parsed;
}
