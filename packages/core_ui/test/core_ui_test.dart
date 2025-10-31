import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:core_ui/core_ui.dart';

void main() {
  testWidgets('HudOverlay renders cam label and timestamp', (WidgetTester tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: HudOverlay(camLabel: 'CAM-01', timestampFormat: 'yyyy-MM-dd HH:mm:ss'),
        ),
      ),
    );

    expect(find.text('CAM-01'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    expect(find.byType(HudTimestamp), findsOneWidget);
  });
}
