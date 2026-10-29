/// Static tile map for the 2x2 CCTV wall.
library;

/// Camera room names in wall order (top-left reading order).
const List<String> cctvRooms = <String>[
  'hallway',
  'kitchen',
  'staircase',
  'storage room',
];

/// Camera ids in wall order.
const List<String> cctvCameraIds = <String>[
  'CAM-01',
  'CAM-02',
  'CAM-03',
  'CAM-04',
];

/// Resolves wall slot [index] to its label and camera id.
///
/// Valid indices are `0..3`; anything else throws a [RangeError].
({String label, String cameraId}) tileFor(int index) {
  if (index < 0 || index >= cctvCameraIds.length) {
    throw RangeError.range(
      index,
      0,
      cctvCameraIds.length - 1,
      'index',
      'tileFor index must be a wall slot 0..3',
    );
  }
  final String cameraId = cctvCameraIds[index];
  final String room = cctvRooms[index];
  return (label: '$cameraId · $room', cameraId: cameraId);
}
