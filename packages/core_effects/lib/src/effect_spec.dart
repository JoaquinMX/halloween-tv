/// Effect spec/profile value types.
library;

/// Effect channel kinds supported by the lightweight CCTV overlays.
enum EffectType {
  /// Horizontal CRT scanlines.
  scanlines,

  /// Edge darkening.
  vignette,

  /// Analog grain / static.
  noise,

  /// Chromatic channel split.
  rgbSplit,

  /// Full signal-loss static burst.
  signalLoss,
}

/// A single effect plus bounded intensity in `[0, 1]`.
///
/// The intensity is validated: values outside `[0, 1]` fail fast with an
/// [AssertionError] in checked mode.
final class EffectSpec {
  /// Creates an effect spec with a validated intensity.
  const EffectSpec(this.type, this.intensity)
      : assert(
          intensity >= 0 && intensity <= 1,
          'EffectSpec intensity must be within 0..1',
        );

  /// Which effect this spec configures.
  final EffectType type;

  /// Strength of the effect, `0` (off) through `1` (full).
  final double intensity;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is EffectSpec &&
          other.type == type &&
          other.intensity == intensity);

  @override
  int get hashCode => Object.hash(type, intensity);

  @override
  String toString() => 'EffectSpec($type, $intensity)';
}

/// Ordered set of effects applied to a tile.
final class EffectProfile {
  /// Creates a profile from [effects].
  const EffectProfile(this.effects);

  /// The specs in this profile, in application order.
  final List<EffectSpec> effects;

  /// Intensity for [type], or `0` when the profile has no such spec.
  double intensityOf(EffectType type) {
    for (final EffectSpec spec in effects) {
      if (spec.type == type) {
        return spec.intensity;
      }
    }
    return 0;
  }

  /// Whether the profile contains [type] with intensity above `0`.
  bool has(EffectType type) => intensityOf(type) > 0;

  @override
  bool operator ==(Object other) {
    if (!identical(this, other) && other is! EffectProfile) {
      return false;
    }
    final EffectProfile that = other as EffectProfile;
    if (effects.length != that.effects.length) {
      return false;
    }
    for (int i = 0; i < effects.length; i++) {
      if (effects[i] != that.effects[i]) {
        return false;
      }
    }
    return true;
  }

  @override
  int get hashCode => Object.hashAll(effects);

  @override
  String toString() => 'EffectProfile($effects)';
}

/// Default CCTV wall profile: mild scanlines, light vignette, infrequent
/// low-level noise. No chromatic split, no signal-loss bursts.
EffectProfile cctvProfile() => const EffectProfile(<EffectSpec>[
      EffectSpec(EffectType.scanlines, 0.30),
      EffectSpec(EffectType.vignette, 0.22),
      EffectSpec(EffectType.noise, 0.12),
    ]);

/// Retro-horror profile: heavier CRT scanlines plus visible chromatic
/// split and stronger grain.
EffectProfile retroProfile() => const EffectProfile(<EffectSpec>[
      EffectSpec(EffectType.scanlines, 0.55),
      EffectSpec(EffectType.vignette, 0.45),
      EffectSpec(EffectType.noise, 0.30),
      EffectSpec(EffectType.rgbSplit, 0.40),
    ]);
