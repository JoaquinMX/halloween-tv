/// Haunted-surveillance CCTV channel (Technical Design v1.0, s4/s7).
///
/// The channel stays decoupled from any concrete video player: the app
/// layer supplies per-tile video surfaces through [CctvTileBuilder].
library;

export 'src/cctv_tiles.dart';
export 'src/plugin.dart';
