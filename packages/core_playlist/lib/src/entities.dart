import 'package:collection/collection.dart';
import 'package:meta/meta.dart';

import 'package:core_cache/core_cache.dart';
import 'package:core_foundation/core_foundation.dart';

/// Overlay configuration for CCTV HUD.
@immutable
class OverlayConfig {
  const OverlayConfig({required this.timestampFmt, required this.glitchIntensity})
      : assert(glitchIntensity >= 0 && glitchIntensity <= 1, 'glitchIntensity must be between 0 and 1.0');

  final String timestampFmt;
  final double glitchIntensity;
}

/// Clip entry for the playlist.
@immutable
class ClipItem {
  const ClipItem({
    required this.id,
    required this.label,
    required this.localKey,
    required this.signedUrl,
    required this.checksumSha256,
    required this.sizeBytes,
  });

  final String id;
  final String label;
  final String localKey;
  final String signedUrl;
  final String checksumSha256;
  final int sizeBytes;
}

/// Playlist data consumed by the playback layer.
@immutable
class Playlist {
  const Playlist({
    required this.version,
    required this.clips,
    required this.overlay,
    required this.expiresAt,
  }) : assert(clips.length == CoreConstants.requiredClipCount, 'Playlist must contain exactly four clips.');

  final int version;
  final List<ClipItem> clips;
  final OverlayConfig overlay;
  final DateTime expiresAt;
}

/// Representation of a playlist ready for playback.
@immutable
class PreparedPlaylist {
  const PreparedPlaylist({
    required this.version,
    required this.files,
    required this.source,
    required this.overlay,
    required this.expiresAt,
  });

  final int version;
  final List<PreparedClip> files;
  final PreparedSource source;
  final OverlayConfig overlay;
  final DateTime expiresAt;
}

@immutable
class PreparedClip {
  const PreparedClip({required this.item, required this.file});

  final ClipItem item;
  final FileRef file;
}

enum PreparedSource { cache, downloaded }

extension ClipListChecksum on Iterable<ClipItem> {
  bool hasUniqueLocalKeys() {
    final Set<String> keys = <String>{};
    for (final ClipItem clip in this) {
      if (!keys.add(clip.localKey)) {
        return false;
      }
    }
    return true;
  }
}
