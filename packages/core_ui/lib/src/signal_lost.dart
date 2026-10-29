/// SIGNAL LOST fallback tile.
library;

import 'package:flutter/material.dart';

import 'cctv_theme.dart';

/// Full-tile fallback shown when a camera feed fails.
class SignalLost extends StatelessWidget {
  /// Creates the fallback; copy defaults to `SIGNAL LOST`.
  const SignalLost({super.key, this.message = 'SIGNAL LOST'});

  /// Fallback copy.
  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: CctvTheme.gutter,
      child: Center(
        child: Text(message, style: CctvTheme.signalLostStyle),
      ),
    );
  }
}
