// On-device camera join regression (physical Pixel, manual run).
//
// Run (from apps/companion_app, release + live defines, permission
// pre-granted so no OS dialog blocks the run):
//
//   adb -s <serial> shell pm grant <package> android.permission.CAMERA
//   flutter test integration_test/camera_join_scan_device_test.dart \
//     --dart-define=COMPANION_FIREBASE_API_KEY=... \
//     --dart-define=COMPANION_FIREBASE_APP_ID=... \
//     --dart-define=COMPANION_FIREBASE_PROJECT_ID=halloween-tv \
//     --dart-define=COMPANION_FUNCTIONS_REGION=us-central1
//
// What it proves on hardware: the shipped join screen pushes the real
// QrScanScreen and the native camera preview initializes (no black stall
// after the permission grant), cancellation returns to a usable join form,
// and the type-or-paste path still joins. Aiming the camera at a real
// party QR and reaching the lineup is covered by the manual written
// procedure in docs/COMPANION-CAMERA-PROOF.md (human aims the camera;
// automation cannot point the lens).
//
// Live paste-join runs only when DEVICE_PARTY_ID/DEVICE_CHANNEL_ID are
// supplied; otherwise it reports the skip. It registers one guest device
// against the seeded rehearsal party (same cost class as the typed manual
// join in rehearsal NOTES — no generation, no spend).
library;

import 'package:companion_app/src/companion_app.dart';
import 'package:companion_app/src/join/qr_scan_screen.dart';
import 'package:companion_app/src/ui/host_entry_screen.dart';
import 'package:companion_app/src/ui/join_screen.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const String _devicePartyId = String.fromEnvironment('DEVICE_PARTY_ID');
const String _deviceChannelId = String.fromEnvironment('DEVICE_CHANNEL_ID');

Future<void> _settle(WidgetTester tester) async {
  for (int i = 0; i < 12; i++) {
    await tester.pump(const Duration(milliseconds: 250));
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('device: granted camera opens the live scanner', (tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await tester.pumpWidget(const CompanionApp());
    await _settle(tester);
    // Host-first boot: take the explicit guest route before scanning.
    expect(find.byKey(HostEntryScreen.joinAsGuestKey), findsOneWidget);
    await tester.tap(find.byKey(HostEntryScreen.joinAsGuestKey));
    await _settle(tester);
    expect(find.byKey(JoinScreen.scanKey), findsOneWidget);

    await tester.ensureVisible(find.byKey(JoinScreen.scanKey));
    await tester.pump(const Duration(milliseconds: 250));
    await tester.tap(find.byKey(JoinScreen.scanKey));
    await _settle(tester);

    // The real scan screen is up (camera preview initializes on device;
    // a post-grant stall would leave the join screen showing instead).
    expect(find.byType(QrScanScreen), findsOneWidget);
    expect(find.byKey(QrScanScreen.scannerKey), findsOneWidget);

    await tester.tap(find.byKey(QrScanScreen.closeKey));
    await _settle(tester);
    expect(find.byType(QrScanScreen), findsNothing);
    expect(find.byKey(JoinScreen.scanKey), findsOneWidget);
  });

  testWidgets('device: pasted join data joins the seeded party', (
    tester,
  ) async {
    if (_devicePartyId.isEmpty || _deviceChannelId.isEmpty) {
      // ignore: avoid_print
      print(
        'SKIP live join: pass --dart-define=DEVICE_PARTY_ID=... '
        'DEVICE_CHANNEL_ID=... (see docs/COMPANION-CAMERA-PROOF.md).',
      );
      return;
    }
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await tester.pumpWidget(const CompanionApp());
    await _settle(tester);
    await tester.tap(find.byKey(HostEntryScreen.joinAsGuestKey));
    await _settle(tester);

    await tester.enterText(
      find.byKey(JoinScreen.payloadFieldKey),
      '{"partyId":"$_devicePartyId","channelId":"$_deviceChannelId"}',
    );
    await tester.ensureVisible(find.byKey(JoinScreen.submitKey));
    await tester.pump(const Duration(milliseconds: 250));
    await tester.tap(find.byKey(JoinScreen.submitKey));
    await _settle(tester);

    expect(find.textContaining('Manifest version'), findsOneWidget);
  });
}
