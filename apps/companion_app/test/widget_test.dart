// Companion bootstrap widget test: boots the real [CompanionApp] with the
// default unconfigured/offline composition root.
// No Firebase initialization, no network traffic.

import 'package:companion_app/src/companion_app.dart';
import 'package:companion_app/src/ui/join_screen.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('Companion boots unconfigured to the join screen', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const CompanionApp());
    await tester.pumpAndSettle();

    expect(find.byKey(JoinScreen.partyFieldKey), findsOneWidget);
    expect(find.byKey(JoinScreen.deviceFieldKey), findsOneWidget);
    expect(find.byKey(JoinScreen.channelFieldKey), findsOneWidget);
    expect(find.byKey(JoinScreen.submitKey), findsOneWidget);
    expect(find.textContaining('organizer'), findsWidgets);
    expect(tester.takeException(), isNull);
  });
}
