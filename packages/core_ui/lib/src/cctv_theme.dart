/// CCTV wall theme: dark gutters, high-contrast large text.
library;

import 'package:flutter/material.dart';

/// Shared visual constants for the CCTV wall.
abstract final class CctvTheme {
  /// Gutter / background color between and behind tiles.
  static const Color gutter = Colors.black;

  /// Tile frame edge color.
  static const Color frameEdge = Color(0xFF2A2A2A);

  /// Recording indicator red.
  static const Color recRed = Color(0xFFFF2B2B);

  /// High-contrast large camera label style (white on black).
  static const TextStyle labelStyle = TextStyle(
    color: Colors.white,
    fontSize: 28,
    fontWeight: FontWeight.w700,
    letterSpacing: 1.5,
    shadows: <Shadow>[
      Shadow(color: Colors.black, blurRadius: 4, offset: Offset(1, 1)),
    ],
  );

  /// High-contrast wall-clock timestamp style.
  static const TextStyle timestampStyle = TextStyle(
    color: Colors.white,
    fontSize: 24,
    fontWeight: FontWeight.w600,
    fontFeatures: <FontFeature>[FontFeature.tabularFigures()],
    shadows: <Shadow>[
      Shadow(color: Colors.black, blurRadius: 4, offset: Offset(1, 1)),
    ],
  );

  /// Small high-contrast style for badges (REC / status chips).
  static const TextStyle badgeStyle = TextStyle(
    color: Colors.white,
    fontSize: 20,
    fontWeight: FontWeight.w700,
    letterSpacing: 2,
  );

  /// Signal-lost fallback text style.
  static const TextStyle signalLostStyle = TextStyle(
    color: Color(0xFFFF5252),
    fontSize: 32,
    fontWeight: FontWeight.w800,
    letterSpacing: 3,
  );

  /// Dark wall theme: black gutters, white high-contrast text.
  static ThemeData dark() => ThemeData.dark(useMaterial3: true).copyWith(
        scaffoldBackgroundColor: gutter,
        canvasColor: gutter,
        textTheme: ThemeData.dark(useMaterial3: true).textTheme.apply(
              bodyColor: Colors.white,
              displayColor: Colors.white,
            ),
      );
}
