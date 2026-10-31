/// Static tile map for the 2x2 CCTV wall.
///
/// Derived from `core_playlist`'s `cctvSlots` — the single source of truth
/// for camera identity (owner Q3). No `CAM-0x` literals live here; id, wall
/// order, and default room labels all come from the slot list, so adding a
/// camera in `core_playlist` flows through without touching this file.
library;

import 'package:core_playlist/core_playlist.dart';

/// Camera room names in wall order (top-left reading order).
///
/// Derived from `cctvSlots`; kept for callers that only need rooms.
final List<String> cctvRooms = List<String>.unmodifiable(<String>[
  for (final CctvSlot slot in cctvSlots) slot.room,
]);

/// Camera ids in wall order.
///
/// Derived from `cctvSlots`; kept for callers that only need ids.
final List<String> cctvCameraIds = List<String>.unmodifiable(<String>[
  for (final CctvSlot slot in cctvSlots) slot.id,
]);

/// Resolves wall slot [index] to its label and camera id.
///
/// Valid indices are `0..3`; anything else throws a [RangeError]. Pass
/// [label] to override the slot default with a config-driven label (e.g. a
/// manifest clip label); absent or blank overrides fall back to the
/// `core_playlist` slot default. See also [tileForCamera] and [tileForClip].
({String label, String cameraId}) tileFor(int index, {String? label}) {
  if (index < 0 || index >= cctvSlots.length) {
    throw RangeError.range(
      index,
      0,
      cctvSlots.length - 1,
      'index',
      'tileFor index must be a wall slot 0..3',
    );
  }
  final CctvSlot slot = cctvSlots[index];
  final String resolved = (label != null && label.trim().isNotEmpty)
      ? label
      : slot.defaultLabel;
  return (label: resolved, cameraId: slot.id);
}

/// Resolves the wall slot for [cameraId] to its label and camera id.
///
/// Throws [ArgumentError] for unknown cameras; the wall converts a throwing
/// tile builder into a `SIGNAL LOST` tile so one bad slot cannot take the
/// wall down. Pass [label] to override the slot default (see [tileFor]).
({String label, String cameraId}) tileForCamera(
  String cameraId, {
  String? label,
}) {
  final CctvSlot? slot = slotForCameraId(cameraId);
  if (slot == null) {
    throw ArgumentError.value(cameraId, 'cameraId', 'unknown CCTV camera id');
  }
  return tileFor(slot.index, label: label);
}

/// Resolves the wall slot for manifest [clip].
///
/// Delegates to [resolveCctvLabel] for the label (custom clip label wins,
/// else the `core_playlist` slot default) and to [tileForCamera] for slot
/// placement — this is the end-to-end manifest-to-wall-label path the wall
/// uses for config-driven labels (owner Q3).
({String label, String cameraId}) tileForClip(ClipDescriptor clip) =>
    tileForCamera(clip.cameraId, label: resolveCctvLabel(clip));
