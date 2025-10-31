import 'package:meta/meta.dart';

/// Parameters controlling the lightweight glitch preset.
@immutable
class EffectsPreset {
  const EffectsPreset({
    required this.scanlines,
    required this.noise,
    required this.rgbSplit,
    required this.vignette,
  });

  final double scanlines;
  final double noise;
  final double rgbSplit;
  final double vignette;

  static const EffectsPreset defaultPreset = EffectsPreset(
    scanlines: 0.25,
    noise: 0.15,
    rgbSplit: 0.012,
    vignette: 0.12,
  );
}
