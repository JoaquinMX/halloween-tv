/// CCTV tile chrome: video surface + HUD + effect overlay + error state.
library;

import 'package:flutter/material.dart';

import 'cctv_theme.dart';
import 'signal_lost.dart';

/// Chrome frame for one wall tile.
///
/// Slots:
/// * [child] — the video surface supplied by the app layer.
/// * [hud] — heads-up display overlay (e.g. [HudOverlay]).
/// * [effectOverlay] — CRT effect overlay (scanlines / vignette / noise).
///
/// When [hasError] is true the [SignalLost] fallback replaces the tile.
/// Set [disableEffects] to drop the effect overlay (used by tests and the
/// hidden recovery overlay).
class CctvTile extends StatelessWidget {
  /// Creates a tile.
  const CctvTile({
    super.key,
    required this.child,
    this.hud,
    this.effectOverlay,
    this.hasError = false,
    this.disableEffects = false,
    this.errorFallback = const SignalLost(),
  });

  /// Video surface for this tile.
  final Widget child;

  /// HUD overlay widget.
  final Widget? hud;

  /// Effect overlay widget.
  final Widget? effectOverlay;

  /// Whether the feed failed (shows the [SignalLost] fallback).
  final bool hasError;

  /// Whether to hide the effect overlay.
  final bool disableEffects;

  /// Fallback shown when [hasError] is true.
  final Widget errorFallback;

  @override
  Widget build(BuildContext context) {
    if (hasError) {
      return errorFallback;
    }
    final bool showEffects =
        !disableEffects && effectOverlay != null;
    return Container(
      decoration: BoxDecoration(
        color: CctvTheme.gutter,
        border: Border.all(color: CctvTheme.frameEdge),
      ),
      child: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          child,
          if (showEffects) effectOverlay!,
          if (hud != null) hud!,
        ],
      ),
    );
  }
}
