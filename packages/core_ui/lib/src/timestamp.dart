import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'typography.dart';

/// Widget that paints a timestamp updated once per second.
class HudTimestamp extends StatefulWidget {
  const HudTimestamp({super.key, required this.format});

  final String format;

  @override
  State<HudTimestamp> createState() => _HudTimestampState();
}

class _HudTimestampState extends State<HudTimestamp> {
  late DateTime _now;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _now = DateTime.now();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      setState(() {
        _now = DateTime.now();
      });
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final DateFormat formatter = DateFormat(widget.format);
    return Text(formatter.format(_now), style: HudTypography.timestamp);
  }
}
