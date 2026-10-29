/// Playback manifest model (Technical Design v1.0, section 8).
///
/// Camera identity (owner Q3 — labels are config-driven, never hardcoded):
/// [CctvSlot]/[cctvSlots] is the single source of truth for CCTV camera
/// identity — canonical wall order, camera ids, and default room labels.
/// The `channel_cctv` tile map, the tv_app asset catalog, and wall-slot
/// label resolution all derive from it; no `CAM-0x` literals are duplicated
/// in other layers.
///
/// Port direction (finding D-08 — recorded exception): the control-plane
/// ports (`ManifestSource`, `SettingsPort`) are owned by the contracts
/// layer in `package:channel_api/channel_api.dart`, so channels can consume
/// them without importing `infra_*`. The `infra_*` packages ship only the
/// adapters bound to those contracts; their barrels keep re-exporting the
/// port names so existing importers keep compiling.
library;

import 'package:core_foundation/core_foundation.dart';

/// One CCTV wall slot: camera identity plus its default presentation.
///
/// Wall order is the order of `cctvSlots` (top-left reading order).
final class CctvSlot {
  /// Camera id (e.g. `CAM-01`).
  final String id;

  /// Wall slot index (`0..3`; matches the position in [cctvSlots]).
  final int index;

  /// Default room name shown on the tile HUD.
  ///
  /// Replaceable per clip by the manifest `label` field (see
  /// [ClipDescriptor.label] and [resolveCctvLabel]).
  final String room;

  /// Creates a slot binding [id] to wall position [index] with default
  /// room [room].
  const CctvSlot({required this.id, required this.index, required this.room});

  /// Default tile label (`'$id · $room'`), used when the manifest clip
  /// carries no custom label.
  String get defaultLabel => '$id · $room';

  @override
  String toString() => 'CctvSlot($id, slot $index, $room)';
}

/// Canonical CCTV wall slots in wall order (top-left reading order).
///
/// Single source of truth for camera identity: id, slot index, and default
/// room label travel together so `channel_cctv`, the tv_app asset catalog,
/// and manifest validation can never drift apart. Add a camera here — never
/// by scattering new `CAM-0x` literals across layers.
const List<CctvSlot> cctvSlots = <CctvSlot>[
  CctvSlot(id: 'CAM-01', index: 0, room: 'hallway'),
  CctvSlot(id: 'CAM-02', index: 1, room: 'kitchen'),
  CctvSlot(id: 'CAM-03', index: 2, room: 'staircase'),
  CctvSlot(id: 'CAM-04', index: 3, room: 'storage room'),
];

/// Valid CCTV camera ids, derived from [cctvSlots].
///
/// Kept for callers that only need the id set; prefer [cctvSlots] (or
/// [slotForCameraId]) when order, index, or default labels matter.
final Set<String> kCctvCameraIds = Set<String>.unmodifiable(
  <String>{for (final CctvSlot slot in cctvSlots) slot.id},
);

/// Slot for [cameraId], or `null` when it is not a known camera.
CctvSlot? slotForCameraId(String cameraId) {
  for (final CctvSlot slot in cctvSlots) {
    if (slot.id == cameraId) {
      return slot;
    }
  }
  return null;
}

/// Maximum manifest clip id length.
///
/// The tile HUD ellipsizes long labels (p5 owns the HUD), but ids longer
/// than this are rejected by [validateCctvManifest] so oversized
/// control-plane payloads never reach the wall.
const int kMaxClipIdLength = 64;

/// Resolves the wall-slot label for [clip].
///
/// The manifest clip `label` field wins when present and non-blank (owner
/// Q3: labels are config-driven and replaceable); otherwise the
/// [CctvSlot.defaultLabel] for the clip's camera applies. Unknown cameras
/// fall back to the raw camera id — validation rejects those separately.
String resolveCctvLabel(ClipDescriptor clip) {
  final String? custom = clip.label;
  if (custom != null && custom.trim().isNotEmpty) {
    return custom;
  }
  final CctvSlot? slot = slotForCameraId(clip.cameraId);
  if (slot != null) {
    return slot.defaultLabel;
  }
  return clip.cameraId;
}

final RegExp _sha256Pattern = RegExp(r'^[0-9a-fA-F]{64}$');

/// True when [value] is a 64 character hex sha256 digest.
///
/// Digests are compared and stored as lowercase hex elsewhere; this helper
/// only checks well-formedness so callers can normalise case themselves.
bool isValidSha256Hex(String value) => _sha256Pattern.hasMatch(value);

/// Clamps [value] into the inclusive [min]..[max] range.
double _clamp(double value, double min, double max) {
  if (value.isNaN) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/// Single clip entry in a manifest.
final class ClipDescriptor {
  /// Clip id, unique within the manifest.
  final String id;

  /// Camera id (for CCTV: one of CAM-01..CAM-04).
  final String cameraId;

  /// Opaque storage object id.
  final String storageObjectId;

  /// Lowercase hex sha256 of the clip bytes.
  final String sha256;

  /// Size in bytes, must be > 0.
  final int sizeBytes;

  /// Duration of the clip.
  final Duration duration;

  /// MIME type (e.g. video/mp4).
  final String mimeType;

  /// Optional config-driven display label (owner Q3).
  ///
  /// When non-null and non-blank, wall slots show this instead of the
  /// [CctvSlot.defaultLabel]. Absent in older manifests; [resolveCctvLabel]
  /// falls back to the slot default. Never validated for length — the tile
  /// HUD ellipsizes (p5 owns the HUD).
  final String? label;

  const ClipDescriptor({
    required this.id,
    required this.cameraId,
    required this.storageObjectId,
    required this.sha256,
    required this.sizeBytes,
    required this.duration,
    required this.mimeType,
    this.label,
  });

  Map<String, Object?> toJson() {
    final Map<String, Object?> map = <String, Object?>{
      'id': id,
      'cameraId': cameraId,
      'storageObjectId': storageObjectId,
      'sha256': sha256,
      'sizeBytes': sizeBytes,
      'durationMs': duration.inMilliseconds,
      'mimeType': mimeType,
    };
    // Only newer manifests carry `label`; omitting it when null keeps the
    // wire shape of older manifests byte-identical.
    if (label != null) {
      map['label'] = label;
    }
    return map;
  }

  factory ClipDescriptor.fromJson(Map<String, Object?> json) => ClipDescriptor(
    id: json['id']! as String,
    cameraId: json['cameraId']! as String,
    storageObjectId: json['storageObjectId']! as String,
    sha256: json['sha256']! as String,
    sizeBytes: (json['sizeBytes']! as num).toInt(),
    duration: Duration(milliseconds: (json['durationMs']! as num).toInt()),
    mimeType: json['mimeType']! as String,
    label: json['label'] as String?,
  );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is ClipDescriptor &&
          other.id == id &&
          other.cameraId == cameraId &&
          other.storageObjectId == storageObjectId &&
          other.sha256 == sha256 &&
          other.sizeBytes == sizeBytes &&
          other.duration == duration &&
          other.mimeType == mimeType &&
          other.label == label);

  @override
  int get hashCode => Object.hash(
    id,
    cameraId,
    storageObjectId,
    sha256,
    sizeBytes,
    duration,
    mimeType,
    label,
  );

  @override
  String toString() => 'ClipDescriptor($id, $cameraId)';
}

/// Overlay tuning with bounded numerics (all clamped to `0.0 .. 1.0`).
final class OverlaySettings {
  /// Scanline opacity in [0, 1].
  final double scanlineOpacity;

  /// Noise/grain level in [0, 1].
  final double noiseLevel;

  /// Vignette strength in [0, 1].
  final double vignette;

  const OverlaySettings({
    this.scanlineOpacity = 0.5,
    this.noiseLevel = 0.3,
    this.vignette = 0.5,
  }) : assert(scanlineOpacity >= 0 && scanlineOpacity <= 1),
       assert(noiseLevel >= 0 && noiseLevel <= 1),
       assert(vignette >= 0 && vignette <= 1);

  /// Builds settings from untrusted numeric input, clamping each value
  /// into `0.0 .. 1.0` (NaN becomes the lower bound).
  factory OverlaySettings.clamped({
    double scanlineOpacity = 0.5,
    double noiseLevel = 0.3,
    double vignette = 0.5,
  }) => OverlaySettings(
    scanlineOpacity: _clamp(scanlineOpacity, 0.0, 1.0),
    noiseLevel: _clamp(noiseLevel, 0.0, 1.0),
    vignette: _clamp(vignette, 0.0, 1.0),
  );

  factory OverlaySettings.fromJson(Map<String, Object?> json) =>
      OverlaySettings.clamped(
        scanlineOpacity: ((json['scanlineOpacity'] ?? 0.5) as num).toDouble(),
        noiseLevel: ((json['noiseLevel'] ?? 0.3) as num).toDouble(),
        vignette: ((json['vignette'] ?? 0.5) as num).toDouble(),
      );

  Map<String, Object?> toJson() => <String, Object?>{
    'scanlineOpacity': scanlineOpacity,
    'noiseLevel': noiseLevel,
    'vignette': vignette,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is OverlaySettings &&
          other.scanlineOpacity == scanlineOpacity &&
          other.noiseLevel == noiseLevel &&
          other.vignette == vignette);

  @override
  int get hashCode => Object.hash(scanlineOpacity, noiseLevel, vignette);

  @override
  String toString() =>
      'OverlaySettings(scanline: $scanlineOpacity, '
      'noise: $noiseLevel, vignette: $vignette)';
}

/// A published set of clips for one party + channel.
final class PlaybackManifest {
  /// Party this manifest belongs to (non-empty).
  final String partyId;

  /// Channel this manifest belongs to (non-empty).
  final String channelId;

  /// Manifest version, must be > 0.
  final int version;

  /// Clips in playback order.
  final List<ClipDescriptor> clips;

  /// Overlay tuning.
  final OverlaySettings overlay;

  /// Publish timestamp.
  final DateTime publishedAt;

  PlaybackManifest({
    required this.partyId,
    required this.channelId,
    required this.version,
    required List<ClipDescriptor> clips,
    this.overlay = const OverlaySettings(),
    required this.publishedAt,
  }) : clips = List<ClipDescriptor>.unmodifiable(clips);

  Map<String, Object?> toJson() => <String, Object?>{
    'partyId': partyId,
    'channelId': channelId,
    'version': version,
    'clips': clips.map((c) => c.toJson()).toList(growable: false),
    'overlay': overlay.toJson(),
    'publishedAt': publishedAt.toUtc().toIso8601String(),
  };

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) {
      return true;
    }
    if (other is! PlaybackManifest ||
        other.partyId != partyId ||
        other.channelId != channelId ||
        other.version != version ||
        other.overlay != overlay ||
        other.publishedAt.toUtc() != publishedAt.toUtc() ||
        other.clips.length != clips.length) {
      return false;
    }
    for (var i = 0; i < clips.length; i++) {
      if (other.clips[i] != clips[i]) {
        return false;
      }
    }
    return true;
  }

  @override
  int get hashCode => Object.hash(
    partyId,
    channelId,
    version,
    Object.hashAll(clips),
    overlay,
    publishedAt.toUtc(),
  );

  @override
  String toString() =>
      'PlaybackManifest($partyId/$channelId v$version, '
      '${clips.length} clips)';
}

/// Parses a manifest from decoded JSON; throws [FormatException] on bad shape.
PlaybackManifest parseManifest(Map<String, Object?> json) {
  try {
    final partyId = json['partyId']! as String;
    final channelId = json['channelId']! as String;
    final version = (json['version']! as num).toInt();
    final rawClips = json['clips']! as List<Object?>;
    final clips = rawClips
        .map(
          (e) => ClipDescriptor.fromJson(
            Map<String, Object?>.from(e! as Map<Object?, Object?>),
          ),
        )
        .toList(growable: false);
    final rawOverlay = json['overlay'];
    if (rawOverlay != null && rawOverlay is! Map) {
      throw const FormatException('overlay must be a JSON object');
    }
    final overlay = rawOverlay == null
        ? const OverlaySettings()
        : OverlaySettings.fromJson(
            Map<String, Object?>.from(rawOverlay as Map<Object?, Object?>),
          );
    final publishedAt = DateTime.parse(json['publishedAt']! as String);
    return PlaybackManifest(
      partyId: partyId,
      channelId: channelId,
      version: version,
      clips: clips,
      overlay: overlay,
      publishedAt: publishedAt,
    );
  } on FormatException {
    rethrow;
  } catch (e) {
    throw FormatException('Invalid manifest JSON: $e');
  }
}

/// Validates CCTV manifest rules.
///
/// Enforces: non-empty party/channel, version > 0, exactly 4 clips with
/// unique ids (each at most [kMaxClipIdLength] characters) and unique
/// cameraId each in [kCctvCameraIds] (derived from [cctvSlots]), sane sha256
/// (64 hex chars), sizeBytes > 0 and positive duration. Clip `label` values
/// are config-driven display strings (owner Q3) and are not length-checked
/// here — the tile HUD ellipsizes them.
Result<PlaybackManifest> validateCctvManifest(PlaybackManifest m) {
  if (m.partyId.trim().isEmpty) {
    return const Err<PlaybackManifest>('partyId must be non-empty');
  }
  if (m.channelId.trim().isEmpty) {
    return const Err<PlaybackManifest>('channelId must be non-empty');
  }
  if (m.version <= 0) {
    return const Err<PlaybackManifest>('version must be > 0');
  }
  if (m.clips.length != 4) {
    return Err<PlaybackManifest>(
      'cctv manifest must have exactly 4 clips, got ${m.clips.length}',
    );
  }
  final seenCameras = <String>{};
  final seenClipIds = <String>{};
  for (final clip in m.clips) {
    if (clip.id.trim().isEmpty) {
      return const Err<PlaybackManifest>('clip id must be non-empty');
    }
    if (clip.id.length > kMaxClipIdLength) {
      return Err<PlaybackManifest>(
        'clip id ${clip.id} exceeds $kMaxClipIdLength characters',
      );
    }
    if (!seenClipIds.add(clip.id)) {
      return Err<PlaybackManifest>('duplicate clip id ${clip.id}');
    }
    if (!kCctvCameraIds.contains(clip.cameraId)) {
      return Err<PlaybackManifest>(
        'unknown cameraId ${clip.cameraId}; expected one of $kCctvCameraIds',
      );
    }
    if (!seenCameras.add(clip.cameraId)) {
      return Err<PlaybackManifest>('duplicate cameraId ${clip.cameraId}');
    }
    if (clip.storageObjectId.trim().isEmpty) {
      return const Err<PlaybackManifest>('storageObjectId must be non-empty');
    }
    if (!isValidSha256Hex(clip.sha256)) {
      return Err<PlaybackManifest>('invalid sha256 for clip ${clip.id}');
    }
    if (clip.sizeBytes <= 0) {
      return Err<PlaybackManifest>('sizeBytes must be > 0 for clip ${clip.id}');
    }
    if (clip.duration.inMilliseconds <= 0) {
      return Err<PlaybackManifest>('duration must be > 0 for clip ${clip.id}');
    }
    if (clip.mimeType.trim().isEmpty) {
      return const Err<PlaybackManifest>('mimeType must be non-empty');
    }
  }
  return Ok<PlaybackManifest>(m);
}

/// Validates that [candidate] advances beyond [committedVersion].
///
/// A manifest with the same version is not a new publication: callers may
/// treat an identical, already committed manifest as an idempotent cache hit,
/// but must reject it as an update. This keeps version ordering explicit at
/// the point where persisted state is available.
Result<PlaybackManifest> validateManifestVersion(
  PlaybackManifest candidate,
  int? committedVersion,
) {
  if (candidate.version <= 0) {
    return const Err<PlaybackManifest>('version must be > 0');
  }
  if (committedVersion != null && candidate.version <= committedVersion) {
    return Err<PlaybackManifest>(
      'manifest version ${candidate.version} must be newer than '
      'committed version $committedVersion',
    );
  }
  return Ok<PlaybackManifest>(candidate);
}
