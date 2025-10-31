import 'package:flutter/material.dart';

import 'rec_badge.dart';
import 'timestamp.dart';
import 'typography.dart';

/// Composite overlay used for each CCTV tile.
class HudOverlay extends StatelessWidget {
  const HudOverlay({
    super.key,
    required this.camLabel,
    required this.timestampFormat,
  });

  final String camLabel;
  final String timestampFormat;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const RecBadge(),
              const SizedBox(width: 16),
              Text(camLabel, style: HudTypography.camLabel),
            ],
          ),
          Align(
            alignment: Alignment.bottomRight,
            child: HudTimestamp(format: timestampFormat),
          ),
        ],
      ),
    );
  }
}
