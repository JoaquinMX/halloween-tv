import 'package:flutter/foundation.dart';

import 'effects_preset.dart';

/// Lightweight effect engine that exposes state to UI overlays.
class EffectsEngine {
  EffectsEngine({EffectsPreset preset = EffectsPreset.defaultPreset, bool enabled = true})
      : _preset = ValueNotifier<EffectsPreset>(preset),
        _enabled = ValueNotifier<bool>(enabled);

  final ValueNotifier<EffectsPreset> _preset;
  final ValueNotifier<bool> _enabled;

  ValueListenable<EffectsPreset> get preset => _preset;
  ValueListenable<bool> get enabled => _enabled;

  void updatePreset(EffectsPreset preset) => _preset.value = preset;
  void toggle(bool enabled) => _enabled.value = enabled;
}
