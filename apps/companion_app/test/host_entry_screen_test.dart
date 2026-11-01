// Host entry screen pairing-code wiring (phone host-join fix).
//
// Exercises the REAL HostEntryScreen + REAL payload parser; only the
// device-identity store is seeded via SharedPreferences and the scanner
// boundary is substituted. No network traffic.
import 'package:companion_app/src/join/device_identity_store.dart';
import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:companion_app/src/join/join_payload_scanner.dart';
import 'package:companion_app/src/ui/host_entry_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const String kGuestDeviceId = 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const String kHostDeviceId = 'p-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const String kHostToken =
    'hi-0123456789abcdef0123456789abcdef0123456789abcdef01';

String hostPayload({String? pairingCode = '123456'}) =>
    '{"partyId":"party-1","channelId":"cctv","role":"host",'
    '"inviteToken":"$kHostToken"'
    '${pairingCode == null ? '' : ',"pairingCode":"$pairingCode"'}}';

final class FakeScanner implements JoinPayloadScanner {
  FakeScanner(this.result);
  final JoinPayloadScanResult result;
  @override
  Future<JoinPayloadScanResult> scan([BuildContext? context]) async => result;
}

Future<void> pumpEntry(
  WidgetTester tester, {
  Future<void> Function(GuestJoinData data)? onHostJoin,
  Future<void> Function(GuestJoinData data, String code)? onHostJoinWithCode,
  JoinPayloadScanner scanner = const UnavailableJoinPayloadScanner(),
}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{
    DeviceIdentityStore.hostStorageKey: kHostDeviceId,
    DeviceIdentityStore.storageKey: kGuestDeviceId,
  });
  await tester.pumpWidget(
    MaterialApp(
      home: HostEntryScreen(
        onHostJoin: (GuestJoinData data) async {
          if (onHostJoin == null) {
            fail('unexpected legacy host join');
          }
          await onHostJoin(data);
        },
        onHostJoinWithCode: onHostJoinWithCode == null
            ? null
            : (GuestJoinData data, String code) async =>
                onHostJoinWithCode(data, code),
        onJoinAsGuest: () {},
        scanner: scanner,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('typed code reaches the with-code callback', (tester) async {
    GuestJoinData? received;
    String? receivedCode;
    await pumpEntry(
      tester,
      onHostJoinWithCode: (data, code) async {
        received = data;
        receivedCode = code;
      },
    );
    await tester.enterText(
      find.byKey(HostEntryScreen.payloadFieldKey),
      hostPayload(pairingCode: null),
    );
    await tester.enterText(
      find.byKey(HostEntryScreen.pairingCodeFieldKey),
      '123456',
    );
    await tester.tap(find.byKey(HostEntryScreen.submitKey));
    await tester.pumpAndSettle();

    expect(received, isNotNull);
    expect(received?.role, JoinRole.host);
    expect(received?.inviteToken, kHostToken);
    expect(receivedCode, '123456');
    expect(find.byKey(HostEntryScreen.errorKey), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('prefilled-from-payload code flows identically', (tester) async {
    GuestJoinData? scannedData;
    String? scannedCode;
    await pumpEntry(
      tester,
      onHostJoinWithCode: (data, code) async {
        scannedData = data;
        scannedCode = code;
      },
      scanner: FakeScanner(JoinPayloadText(hostPayload(pairingCode: '654321'))),
    );
    await tester.tap(find.byKey(HostEntryScreen.scanKey));
    await tester.pumpAndSettle();

    GuestJoinData? pastedData;
    String? pastedCode;
    await pumpEntry(
      tester,
      onHostJoinWithCode: (data, code) async {
        pastedData = data;
        pastedCode = code;
      },
    );
    await tester.enterText(
      find.byKey(HostEntryScreen.payloadFieldKey),
      hostPayload(pairingCode: '654321'),
    );
    await tester.tap(find.byKey(HostEntryScreen.submitKey));
    await tester.pumpAndSettle();

    expect(scannedData, isNotNull);
    expect(pastedData, isNotNull);
    expect(scannedData, pastedData);
    expect(scannedCode, '654321');
    expect(pastedCode, '654321');
    expect(tester.takeException(), isNull);
  });

  testWidgets('legacy no-code path still calls onHostJoin', (tester) async {
    GuestJoinData? received;
    SharedPreferences.setMockInitialValues(<String, Object>{
      DeviceIdentityStore.hostStorageKey: kHostDeviceId,
      DeviceIdentityStore.storageKey: kGuestDeviceId,
    });
    await tester.pumpWidget(
      MaterialApp(
        home: HostEntryScreen(
          onHostJoin: (GuestJoinData data) async => received = data,
          onJoinAsGuest: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(HostEntryScreen.payloadFieldKey),
      hostPayload(pairingCode: null),
    );
    await tester.enterText(
      find.byKey(HostEntryScreen.pairingCodeFieldKey),
      '777777',
    );
    await tester.tap(find.byKey(HostEntryScreen.submitKey));
    await tester.pumpAndSettle();

    expect(received, isNotNull);
    expect(received?.role, JoinRole.host);
    expect(received?.inviteToken, kHostToken);
    expect(find.byKey(HostEntryScreen.errorKey), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
