/// Playback manifest model (Technical Design v1.0, section 8).
library;

import 'package:core_foundation/core_foundation.dart';

/// Valid CCTV camera ids.
const Set<String> kCctvCameraIds = <String>{
  'CAM-01',
  'CAM-02',
  'CAM-03',
  'CAM-04',
};

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

  const ClipDescriptor({
    required this.id,
    required this.cameraId,
    required this.storageObjectId,
    required this.sha256,
    required this.sizeBytes,
    required this.duration,
    required this.mimeType,
  });

  Map<String, Object?> toJson() => <String, Object?>{
        'id': id,
        'cameraId': cameraId,
        'storageObjectId': storageObjectId,
        'sha256': sha256,
        'sizeBytes': sizeBytes,
        'durationMs': duration.inMilliseconds,
        'mimeType': mimeType,
      };

  factory ClipDescriptor.fromJson(Map<String, Object?> json) =>
      ClipDescriptor(
        id: json['id']! as String,
        cameraId: json['cameraId']! as String,
        storageObjectId: json['storageObjectId']! as String,
        sha256: json['sha256']! as String,
        sizeBytes: (json['sizeBytes']! as num).toInt(),
        duration: Duration(
            milliseconds: (json['durationMs']! as num).toInt()),
        mimeType: json['mimeType']! as String,
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
          other.mimeType == mimeType);

  @override
  int get hashCode => Object.hash(id, cameraId, storageObjectId, sha256,
      sizeBytes, duration, mimeType);

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
  })  : assert(scanlineOpacity >= 0 && scanlineOpacity <= 1),
        assert(noiseLevel >= 0 && noiseLevel <= 1),
        assert(vignette >= 0 && vignette <= 1);

  /// Builds settings from untrusted numeric input, clamping each value
  /// into `0.0 .. 1.0` (NaN becomes the lower bound).
  factory OverlaySettings.clamped({
    double scanlineOpacity = 0.5,
    double noiseLevel = 0.3,
    double vignette = 0.5,
  }) =>
      OverlaySettings(
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
  String toString() => 'OverlaySettings(scanline: $scanlineOpacity, '
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
  int get hashCode => Object.hash(partyId, channelId, version,
      Object.hashAll(clips), overlay, publishedAt.toUtc());

  @override
  String toString() => 'PlaybackManifest($partyId/$channelId v$version, '
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
        .map((e) => ClipDescriptor.fromJson(
            Map<String, Object?>.from(e! as Map<Object?, Object?>)))
        .toList(growable: false);
    final rawOverlay = json['overlay'];
    if (rawOverlay != null && rawOverlay is! Map) {
      throw const FormatException('overlay must be a JSON object');
    }
    final overlay = rawOverlay == null
        ? const OverlaySettings()
        : OverlaySettings.fromJson(
            Map<String, Object?>.from(rawOverlay as Map<Object?, Object?>));
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
/// unique ids and unique cameraId each in {CAM-01..CAM-04}, sane sha256
/// (64 hex chars), sizeBytes > 0 and positive duration.
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
        'cctv manifest must have exactly 4 clips, got ${m.clips.length}');
  }
  final seenCameras = <String>{};
  final seenClipIds = <String>{};
  for (final clip in m.clips) {
    if (clip.id.trim().isEmpty) {
      return const Err<PlaybackManifest>('clip id must be non-empty');
    }
    if (!seenClipIds.add(clip.id)) {
      return Err<PlaybackManifest>('duplicate clip id ${clip.id}');
    }
    if (!kCctvCameraIds.contains(clip.cameraId)) {
      return Err<PlaybackManifest>(
          'unknown cameraId ${clip.cameraId}; expected one of $kCctvCameraIds');
    }
    if (!seenCameras.add(clip.cameraId)) {
      return Err<PlaybackManifest>('duplicate cameraId ${clip.cameraId}');
    }
    if (clip.storageObjectId.trim().isEmpty) {
      return const Err<PlaybackManifest>(
          'storageObjectId must be non-empty');
    }
    if (!isValidSha256Hex(clip.sha256)) {
      return Err<PlaybackManifest>('invalid sha256 for clip ${clip.id}');
    }
    if (clip.sizeBytes <= 0) {
      return Err<PlaybackManifest>(
          'sizeBytes must be > 0 for clip ${clip.id}');
    }
    if (clip.duration.inMilliseconds <= 0) {
      return Err<PlaybackManifest>(
          'duration must be > 0 for clip ${clip.id}');
    }
    if (clip.mimeType.trim().isEmpty) {
      return const Err<PlaybackManifest>('mimeType must be non-empty');
    }
  }
  return Ok<PlaybackManifest>(m);
}
