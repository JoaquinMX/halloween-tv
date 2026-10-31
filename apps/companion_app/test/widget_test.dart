import 'package:companion_app/src/companion_app.dart';
import 'package:companion_app/src/ui/host_entry_screen.dart';
import 'package:companion_app/src/ui/join_screen.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('Companion boots to the dedicated host entry screen', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(const CompanionApp());
    await tester.pumpAndSettle();
    // Host-first boot: Scan Host QR, paste fallback, explicit guest route.
    expect(find.byKey(HostEntryScreen.scanKey), findsOneWidget);
    expect(find.byKey(HostEntryScreen.payloadFieldKey), findsOneWidget);
    expect(find.byKey(HostEntryScreen.submitKey), findsOneWidget);
    expect(find.byKey(HostEntryScreen.joinAsGuestKey), findsOneWidget);
    // The guest form is one explicit tap away, not the boot screen.
    expect(find.byKey(JoinScreen.submitKey), findsNothing);
    expect(tester.takeException(), isNull);
  });
  testWidgets('Join as guest reaches the anonymous join form', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(const CompanionApp());
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(HostEntryScreen.joinAsGuestKey));
    await tester.pumpAndSettle();
    expect(find.byKey(JoinScreen.partyFieldKey), findsOneWidget);
    expect(find.byKey(JoinScreen.channelFieldKey), findsOneWidget);
    expect(find.byKey(JoinScreen.pinFieldKey), findsOneWidget);
    expect(find.byKey(JoinScreen.submitKey), findsOneWidget);
    expect(find.textContaining('organizer'), findsWidgets);
    expect(find.byKey(const Key('join-device-id')), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
