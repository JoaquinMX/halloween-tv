import 'package:companion_app/src/join/device_identity_store.dart';
import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:companion_app/src/ui/join_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('manual and pasted data submit with local identity; no device or name fields', (tester) async {
    SharedPreferences.setMockInitialValues({}); GuestJoinData? received;
    await tester.pumpWidget(MaterialApp(home: JoinScreen(identityStore: DeviceIdentityStore(), onJoin: (data) async { received = data; })));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('join-device-id')), findsNothing); expect(find.textContaining('Name'), findsNothing);
    await tester.enterText(find.byKey(JoinScreen.partyFieldKey), 'party'); await tester.enterText(find.byKey(JoinScreen.channelFieldKey), 'cctv'); await tester.enterText(find.byKey(JoinScreen.pinFieldKey), '004201');
    await tester.tap(find.byKey(JoinScreen.submitKey)); await tester.pumpAndSettle();
    expect(received?.deviceId.value, matches(RegExp(r'^p-[0-9a-f]{32}$'))); expect(received?.joinPin, '004201');
    received = null; await tester.enterText(find.byKey(JoinScreen.payloadFieldKey), '{"partyId":"paste","channelId":"cctv","deviceId":"evil"}'); await tester.tap(find.byKey(JoinScreen.submitKey)); await tester.pumpAndSettle();
    expect(received?.partyId.value, 'paste'); expect(received?.deviceId.value, isNot('evil'));
  });
  testWidgets('invalid input is blocked', (tester) async {
    SharedPreferences.setMockInitialValues({}); var called = false;
    await tester.pumpWidget(MaterialApp(home: JoinScreen(onJoin: (_) async { called = true; })));
    await tester.pumpAndSettle(); await tester.enterText(find.byKey(JoinScreen.partyFieldKey), 'bad/path'); await tester.enterText(find.byKey(JoinScreen.channelFieldKey), 'c'); await tester.tap(find.byKey(JoinScreen.submitKey)); await tester.pumpAndSettle();
    expect(called, isFalse); expect(find.byKey(JoinScreen.errorKey), findsOneWidget);
  });
}
