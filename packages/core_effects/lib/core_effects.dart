/// Lightweight CCTV visual-effect primitives (Technical Design v1.0, s13).
///
/// Cheap CPU overlays only (scanlines / vignette / noise hints / seeded
/// glitch modulation). No full-screen shaders.
library;

export 'src/effect_spec.dart';
export 'src/glitch_controller.dart';
export 'src/painters.dart';
