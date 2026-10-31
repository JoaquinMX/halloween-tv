// Emulator-backed host administration smoke test.
//
// Run from apps/companion_app after starting the Firebase emulators and
// supplying HOST_INVITE_PAYLOAD (a fresh Host QR JSON from createHostInvite):
//
//   flutter test integration_test/host_admin_emulator_test.dart \
//     --dart-define=HOST_INVITE_PAYLOAD='{"partyId":"...",...}' \
//     --dart-define=COMPANION_FIREBASE_API_KEY=... \
//     --dart-define=COMPANION_FIREBASE_APP_ID=... \
//     --dart-define=COMPANION_FIREBASE_PROJECT_ID=demo-halloween-tv \
//     --dart-define=COMPANION_USE_EMULATOR=true
//
// The one-use invite is deliberately provisioned out of band (the companion
// cannot mint host invitations). This drives real parsing, identity binding,
// joinHost response validation, and the scoped seed-list callable.
library;

import 'package:companion_app/src/companion_app.dart';
import 'package:companion_app/src/join/device_identity_store.dart';
import 'package:companion_app/src/ui/host_entry_screen.dart';
import 'package:companion_app/src/ui/host_panel_screen.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const String _hostInvitePayload = String.fromEnvironment('HOST_INVITE_PAYLOAD');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('emulator: Host QR joins and loads scoped administration', (
    tester,
  ) async {
    if (_hostInvitePayload.isEmpty) {
      // ignore: avoid_print
      print(
        'SKIP host admin: supply HOST_INVITE_PAYLOAD (fresh Host QR JSON).',
      );
      return;
    }
    SharedPreferences.setMockInitialValues(<String, Object>{
      DeviceIdentityStore.hostStorageKey: 'p-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    await tester.pumpWidget(const CompanionApp());
    for (int i = 0; i < 12; i++) {
      await tester.pump(const Duration(milliseconds: 250));
    }
    expect(find.byKey(HostEntryScreen.payloadFieldKey), findsOneWidget);
    await tester.enterText(
      find.byKey(HostEntryScreen.payloadFieldKey),
      _hostInvitePayload,
    );
    await tester.ensureVisible(find.byKey(HostEntryScreen.submitKey));
    await tester.tap(find.byKey(HostEntryScreen.submitKey));
    for (int i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 250));
    }
    expect(find.byKey(HostPanelScreen.listKey), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
