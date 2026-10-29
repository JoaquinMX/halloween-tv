/// Per-tile heads-up display: camera label, REC dot, ticking timestamp.
library;

import 'dart:async';

import 'package:core_foundation/core_foundation.dart';
import 'package:flutter/material.dart';

import 'cctv_theme.dart';

/// Formats [timestamp] as a wall-clock `HH:MM:SS` string.
String formatHudTimestamp(DateTime timestamp) {
  String two(int v) => v.toString().padLeft(2, '0');
  return '${two(timestamp.hour)}:${two(timestamp.minute)}:${two(timestamp.second)}';
}

/// CCTV heads-up display overlay.
///
/// Renders the camera [label], a REC indicator (with a blinking dot when
/// [recBlink] is true), and a ticking wall-clock [timestamp]. Time comes
/// from [clock] so tests can inject a deterministic clock; pass an explicit
/// [timestamp] to freeze the display.
class HudOverlay extends StatefulWidget {
  /// Creates the HUD overlay.
  const HudOverlay({
    super.key,
    required this.label,
    this.rec = true,
    this.timestamp,
    this.recBlink = true,
    this.clock = const SystemClock(),
    this.tickInterval = const Duration(seconds: 1),
  });

  /// Camera label, e.g. `CAM-01`.
  final String label;

  /// Whether the REC indicator is shown.
  final bool rec;

  /// Fixed timestamp to display; when null the [clock] time is used.
  final DateTime? timestamp;

  /// Whether the REC dot blinks (500ms cadence).
  final bool recBlink;

  /// Clock source for the ticking timestamp (injectable for tests).
  final Clock clock;

  /// How often the displayed timestamp refreshes.
  final Duration tickInterval;

  @override
  State<HudOverlay> createState() => _HudOverlayState();
}

class _HudOverlayState extends State<HudOverlay> {
  late DateTime _now;
  bool _recVisible = true;
  Timer? _tickTimer;
  Timer? _blinkTimer;

  @override
  void initState() {
    super.initState();
    _now = widget.timestamp ?? widget.clock.now();
    if (widget.timestamp == null) {
      _tickTimer =
          Timer.periodic(widget.tickInterval, (_) => _onTickClock());
    }
    if (widget.rec && widget.recBlink) {
      _blinkTimer = Timer.periodic(
        const Duration(milliseconds: 500),
        (_) => _onTickBlink(),
      );
    }
  }

  void _onTickClock() {
    if (!mounted) {
      return;
    }
    setState(() {
      _now = widget.clock.now();
    });
  }

  void _onTickBlink() {
    if (!mounted) {
      return;
    }
    setState(() {
      _recVisible = !_recVisible;
    });
  }

  @override
  void dispose() {
    _tickTimer?.cancel();
    _blinkTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: <Widget>[
              if (widget.rec) ...<Widget>[
                _RecDot(visible: !widget.recBlink || _recVisible),
                const SizedBox(width: 8),
                const Text('REC', style: CctvTheme.badgeStyle),
                const SizedBox(width: 16),
              ],
              Expanded(
                child: Text(
                  widget.label,
                  style: CctvTheme.labelStyle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          Align(
            alignment: Alignment.bottomRight,
            child: Text(
              formatHudTimestamp(_now),
              style: CctvTheme.timestampStyle,
            ),
          ),
        ],
      ),
    );
  }
}

/// Solid red recording dot; transparent (layout-preserving) when hidden.
class _RecDot extends StatelessWidget {
  const _RecDot({required this.visible});

  final bool visible;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 16,
      height: 16,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: visible ? CctvTheme.recRed : const Color(0x00000000),
      ),
    );
  }
}
