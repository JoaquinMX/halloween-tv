/// Firestore control-plane adapters: manifest source + document mapping.
///
/// Design authority: Technical Design v1.0 §9 (Firestore control plane).
///
/// Port direction (finding D-08 — recorded here): the `ManifestSource` port
/// interface is owned by the contracts layer in
/// `package:channel_api/channel_api.dart` (`ManifestSource<T>`); this
/// library declares no port of its own and only ships the
/// `PlaybackManifest`-bound adapter ([StaticManifestSource]) plus the
/// document mapping ([manifestFromFirestore]). Channels therefore bind
/// `ManifestSource<PlaybackManifest>` from `channel_api` and never import
/// `infra_*`.
///
/// Backwards compatibility: the barrel
/// (`package:infra_firestore/infra_firestore.dart`) still re-exports
/// [ManifestSource] through this library so existing importers compile; the
/// re-export carries an `@Deprecated` annotation recording the move (Dart
/// raises no deprecation diagnostic for export directives, so the
/// deprecation here is documentation-level — new code must import the port
/// from `channel_api`).
///
/// Every type crossing this boundary belongs to `core_playlist`
/// ([PlaybackManifest], [ClipDescriptor], [OverlaySettings]),
/// `channel_api` (the port), or `core_foundation`; nothing is redefined
/// here.
library;

import 'package:channel_api/channel_api.dart' show ManifestSource;
import 'package:core_playlist/core_playlist.dart';

@Deprecated(
  'ManifestSource moved to the contracts layer (finding D-08): import it '
  'from package:channel_api/channel_api.dart. This infra re-export is kept '
  'only so existing importers compile.',
)
export 'package:channel_api/channel_api.dart' show ManifestSource;

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

/// Fixture-backed `ManifestSource<PlaybackManifest>` that emits [fixture]
/// once per subscription and then closes.
///
/// Used by tests, previews, and offline playback. In stub mode the fixture
/// is authoritative for every requested party/channel, so callers can wire
/// the port before the control plane exists.
class StaticManifestSource implements ManifestSource<PlaybackManifest> {
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
PlaybackManifest manifestFromFirestore(
  Map<String, Object?> doc, {
  DateTime Function()? now,
}) {
  final version = _schemaVersionOf(doc['schemaVersion']);
  if (version != kManifestSchemaVersion) {
    throw ManifestSchemaException(
      'unsupported schemaVersion: $version '
      '(expected $kManifestSchemaVersion)',
    );
  }

  // The deployed backend v1 shape uses `cameraClips` and storage `objectPath`
  // fields. Translate that envelope into the core_playlist wire model while
  // leaving the legacy PlaybackManifest-shaped fixture path intact.
  final Map<String, Object?> payload;
  try {
    payload =
        doc.containsKey('cameraClips')
              ? _playbackPayloadFromBackend(doc, now: now ?? DateTime.now)
              : <String, Object?>{...doc}
          ..remove('schemaVersion');
  } on ManifestSchemaException {
    rethrow;
  } on Object catch (error) {
    throw ManifestSchemaException('invalid manifest payload: $error');
  }
  if (payload['publishedAt'] is DateTime) {
    payload['publishedAt'] = (payload['publishedAt']! as DateTime)
        .toUtc()
        .toIso8601String();
  }
  try {
    return parseManifest(payload);
  } on FormatException catch (error) {
    throw ManifestSchemaException('invalid manifest payload: ${error.message}');
  }
}

Map<String, Object?> _playbackPayloadFromBackend(
  Map<String, Object?> doc, {
  required DateTime Function() now,
}) {
  final rawClips = doc['cameraClips'];
  if (rawClips is! List) {
    throw const ManifestSchemaException('cameraClips must be a list');
  }
  final clips = <Map<String, Object?>>[];
  for (final Object? rawClip in rawClips) {
    if (rawClip is! Map) {
      throw const ManifestSchemaException('cameraClips entries must be maps');
    }
    final clip = Map<String, Object?>.from(rawClip);
    clips.add(<String, Object?>{
      'id': clip['cameraId'],
      'cameraId': clip['cameraId'],
      'storageObjectId': clip['objectPath'],
      'sha256': clip['sha256'],
      'sizeBytes': clip['sizeBytes'],
      'durationMs': clip['durationMs'],
      'mimeType': clip['mimeType'] ?? 'video/mp4',
    });
  }

  // Backend v1 records the publication timestamp as `createdAt`. Seeded
  // emulator fixtures may omit it; in that case the observation time is the
  // best timestamp available to the domain model.
  final Object? publishedAt = doc['publishedAt'] ?? doc['createdAt'];
  final String timestamp = switch (publishedAt) {
    final DateTime value => value.toUtc().toIso8601String(),
    final String value => value,
    _ => now().toUtc().toIso8601String(),
  };

  return <String, Object?>{
    'partyId': doc['partyId'],
    'channelId': doc['channelId'],
    'version': doc['version'],
    'clips': clips,
    'publishedAt': timestamp,
    'overlay': doc['overlay'],
  };
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
