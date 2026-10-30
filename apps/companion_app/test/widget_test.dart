// Scaffold widget test: boots the real (unconfigured) entry point.
// No Firebase initialization, no network traffic.

import 'package:companion_app/main.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('Companion scaffold boots with placeholder home', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const CompanionApp());

    expect(
      find.text('Companion scaffold — join flow lands in p4'),
      findsOneWidget,
    );
  });
}
