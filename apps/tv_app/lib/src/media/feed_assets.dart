/// Bundled fixture clip lookup for the haunted-surveillance wall.
///
/// Phase 1 plays local, muted, looped H.264 fixture clips shipped in
/// `assets/` (see `tool/gen_fixtures.sh`). The manifest tells us *which*
/// cameras exist; this catalog tells the app layer *where* the bytes are.
library;

/// Camera id -> bundled asset path.
///
/// Camera ids mirror `channel_cctv`'s wall slots (`CAM-01`..`CAM-04`).
const Map<String, String> kCameraAssetPaths = <String, String>{
  'CAM-01': 'assets/cam01.mp4',
  'CAM-02': 'assets/cam02.mp4',
  'CAM-03': 'assets/cam03.mp4',
  'CAM-04': 'assets/cam04.mp4',
};

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
