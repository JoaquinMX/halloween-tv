import 'package:flutter/material.dart';

/// Shared typography for CCTV overlays.
class HudTypography {
  HudTypography._();

  static const TextStyle camLabel = TextStyle(
    fontFamily: 'RobotoMono',
    fontSize: 16,
    color: Colors.white,
    letterSpacing: 1.2,
  );

  static const TextStyle recLabel = TextStyle(
    fontFamily: 'RobotoMono',
    fontSize: 14,
    color: Colors.white,
    letterSpacing: 1.1,
  );

  static const TextStyle timestamp = TextStyle(
    fontFamily: 'RobotoMono',
    fontSize: 18,
    color: Colors.white,
  );
}
