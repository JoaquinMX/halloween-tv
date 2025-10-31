import 'package:flutter/material.dart';

import 'typography.dart';

/// Displays a REC badge with blinking indicator.
class RecBadge extends StatefulWidget {
  const RecBadge({super.key, this.blinkDuration = const Duration(milliseconds: 800)});

  final Duration blinkDuration;

  @override
  State<RecBadge> createState() => _RecBadgeState();
}

class _RecBadgeState extends State<RecBadge> with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: widget.blinkDuration)..repeat(reverse: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        FadeTransition(
          opacity: _controller.drive(CurveTween(curve: Curves.easeInOut)),
          child: Container(
            width: 10,
            height: 10,
            decoration: const BoxDecoration(color: Colors.red, shape: BoxShape.circle),
          ),
        ),
        const SizedBox(width: 6),
        const Text('REC', style: HudTypography.recLabel),
      ],
    );
  }
}
