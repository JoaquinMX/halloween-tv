/// Seeded deterministic glitch modulation.
library;

import 'dart:math';

import 'package:flutter/foundation.dart';

/// Drives occasional analog-glitch bursts with a seeded [Random] so tests
/// and replays are deterministic: two controllers built with the same
/// [seed] produce identical intensity sequences.
///
/// Intensities are always bounded to `[0, maxIntensity]`.
final class GlitchController extends ChangeNotifier {
  /// Creates a controller.
  ///
  /// [maxIntensity] and [glitchProbability] must both be within `0..1`.
  GlitchController({
    int seed = 0,
    double maxIntensity = 0.6,
    double glitchProbability = 0.08,
  })  : assert(maxIntensity >= 0 && maxIntensity <= 1),
        assert(glitchProbability >= 0 && glitchProbability <= 1),
        _random = Random(seed),
        maxIntensity = maxIntensity,
        glitchProbability = glitchProbability;

  /// Upper bound applied to every emitted intensity.
  final double maxIntensity;

  /// Per-[tick] probability of starting/continuing a glitch burst.
  final double glitchProbability;

  final Random _random;

  double _currentIntensity = 0;

  /// Current glitch intensity, always within `[0, maxIntensity]`.
  double get currentIntensity => _currentIntensity;

  /// Whether a glitch burst is currently active.
  bool get glitching => _currentIntensity > 0;

  /// Advances the controller one deterministic step.
  void tick() {
    if (_random.nextDouble() < glitchProbability) {
      _currentIntensity = _random.nextDouble() * maxIntensity;
    } else {
      _currentIntensity = 0;
    }
    notifyListeners();
  }

  /// Clears any active glitch.
  void reset() {
    _currentIntensity = 0;
    notifyListeners();
  }
}
