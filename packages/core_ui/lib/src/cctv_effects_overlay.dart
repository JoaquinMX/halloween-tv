/// CRT effect overlay stack for a single CCTV tile.
library;

import 'package:core_effects/core_effects.dart';
import 'package:flutter/widgets.dart';

/// Cheap scanlines + vignette + grain overlay driven by an [EffectProfile].
///
/// The channel layer feeds a seeded glitch intensity in through
/// [glitchIntensity]; everything here is a plain [CustomPaint]/[ColoredBox]
/// stack (no shaders, no image filters), so it stays cheap on wall tiles.
class CctvEffectsOverlay extends StatelessWidget {
  /// Creates the overlay.
  const CctvEffectsOverlay({
    super.key,
    required this.profile,
    this.glitchIntensity = 0,
    this.disableEffects = false,
  });

  /// Effect intensities to render.
  final EffectProfile profile;

  /// Extra grain from a seeded glitch burst, added to the profile noise.
  final double glitchIntensity;

  /// When true nothing is painted at all (tests / hidden recovery overlay).
  final bool disableEffects;

  @override
  Widget build(BuildContext context) {
    if (disableEffects) {
      return const SizedBox.shrink();
    }
    final double scanlines = profile.intensityOf(EffectType.scanlines);
    final double vignette = profile.intensityOf(EffectType.vignette);
    final double noise =
        (profile.intensityOf(EffectType.noise) + glitchIntensity)
            .clamp(0.0, 1.0);
    if (scanlines <= 0 && vignette <= 0 && noise <= 0) {
      return const SizedBox.shrink();
    }
    return IgnorePointer(
      child: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          if (scanlines > 0)
            CustomPaint(
              painter: ScanlinesPainter(opacity: 0.1 + 0.25 * scanlines),
            ),
          if (vignette > 0)
            CustomPaint(painter: VignettePainter(strength: vignette)),
          if (noise > 0)
            ColoredBox(
              color: Color.fromRGBO(255, 255, 255, 0.03 + 0.08 * noise),
            ),
        ],
      ),
    );
  }
}
