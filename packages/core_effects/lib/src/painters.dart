/// Cheap cached custom painters for scanlines and vignette.
library;

import 'package:flutter/widgets.dart';

/// Horizontal CRT scanlines.
///
/// Draws 1-device-pixel dark lines every [gap] logical pixels. The painter
/// is immutable and `const`-constructible so identical instances repaint
/// nothing ([shouldRepaint] compares fields).
final class ScanlinesPainter extends CustomPainter {
  /// Creates a scanlines painter.
  const ScanlinesPainter({
    this.opacity = 0.16,
    this.gap = 4.0,
    this.lineHeight = 1.0,
  })  : assert(opacity >= 0 && opacity <= 1),
        assert(gap > 0),
        assert(lineHeight > 0);

  /// Alpha of each scanline, `0..1`.
  final double opacity;

  /// Vertical distance between scanline starts, in logical pixels.
  final double gap;

  /// Thickness of each scanline, in logical pixels.
  final double lineHeight;

  @override
  void paint(Canvas canvas, Size size) {
    if (opacity <= 0 || size.isEmpty) {
      return;
    }
    final Paint paint = Paint()..color = Color.fromRGBO(0, 0, 0, opacity);
    for (double y = 0; y < size.height; y += gap) {
      canvas.drawRect(Rect.fromLTWH(0, y, size.width, lineHeight), paint);
    }
  }

  @override
  bool shouldRepaint(covariant ScanlinesPainter oldDelegate) =>
      oldDelegate.opacity != opacity ||
      oldDelegate.gap != gap ||
      oldDelegate.lineHeight != lineHeight;
}

/// Soft radial vignette (darkened frame edges).
///
/// Immutable and `const`-constructible; [shouldRepaint] compares fields.
final class VignettePainter extends CustomPainter {
  /// Creates a vignette painter.
  const VignettePainter({this.strength = 0.5})
      : assert(strength >= 0 && strength <= 1);

  /// Edge darkness, `0` (none) through `1` (opaque corners).
  final double strength;

  @override
  void paint(Canvas canvas, Size size) {
    if (strength <= 0 || size.isEmpty) {
      return;
    }
    final Offset center = Offset(size.width / 2, size.height / 2);
    final double radius = size.longestSide * 0.72;
    final Paint paint = Paint()
      ..shader = RadialGradient(
        center: Alignment.center,
        radius: 1.0,
        colors: <Color>[
          const Color(0x00000000),
          Color.fromRGBO(0, 0, 0, 0.75 * strength),
        ],
        stops: const <double>[0.55, 1.0],
      ).createShader(Rect.fromCircle(center: center, radius: radius));
    canvas.drawRect(Offset.zero & size, paint);
  }

  @override
  bool shouldRepaint(covariant VignettePainter oldDelegate) =>
      oldDelegate.strength != strength;
}
