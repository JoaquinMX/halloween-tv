/// Bundled fixture clip lookup for the haunted-surveillance wall.
///
/// Phase 1 plays local, muted, looped H.264 fixture clips shipped in
/// `assets/` (see `tool/gen_fixtures.sh`). The manifest tells us *which*
/// cameras exist; this catalog tells the app layer *where* the bytes are.
///
/// Camera identity comes from `core_playlist`'s `cctvSlots` (single source
/// of truth, owner Q3): the asset map is derived from the slot list in
/// wall-slot order, so no `CAM-0x` literals are duplicated here.
library;

import 'package:core_playlist/core_playlist.dart';

/// Camera id -> bundled asset path.
///
/// Derived from `cctvSlots` in wall-slot order (`cam0N` fixture file per
/// slot index); kept as a map for O(1) tile lookups.
final Map<String, String> kCameraAssetPaths =
    Map<String, String>.unmodifiable(<String, String>{
      for (final CctvSlot slot in cctvSlots)
        slot.id: 'assets/cam0${slot.index + 1}.mp4',
    });

/// Resolves the bundled clip for [cameraId].
///
/// Throws [ArgumentError] for unknown cameras; the wall converts a throwing
/// tile builder into a `SIGNAL LOST` tile so one bad slot cannot take the
/// wall down.
String assetPathForCamera(String cameraId) {
  final String? path = kCameraAssetPaths[cameraId];
  if (path == null) {
    throw ArgumentError.value(
      cameraId,
      'cameraId',
      'no bundled fixture clip for this camera',
    );
  }
  return path;
}
