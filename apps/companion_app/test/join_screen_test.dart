import 'dart:async';

import 'package:companion_app/src/join/device_identity_store.dart';
import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:companion_app/src/join/join_payload_scanner.dart';
import 'package:companion_app/src/ui/join_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

final class _CountingScanner implements JoinPayloadScanner {
  _CountingScanner({Future<JoinPayloadScanResult>? pending})
    : _pending = pending;
  final Future<JoinPayloadScanResult>? _pending;
  int calls = 0;
  @override
  Future<JoinPayloadScanResult> scan([BuildContext? context]) {
    calls++;
    return _pending ?? Future.value(const JoinPayloadUnavailable());
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'manual and pasted data submit with local identity; no device or name fields',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
      GuestJoinData? received;
      await tester.pumpWidget(
        MaterialApp(
          home: JoinScreen(
            identityStore: DeviceIdentityStore(),
            onJoin: (data) async {
              received = data;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('join-device-id')), findsNothing);
      expect(find.textContaining('Name'), findsNothing);
      await tester.enterText(find.byKey(JoinScreen.partyFieldKey), 'party');
      await tester.enterText(find.byKey(JoinScreen.channelFieldKey), 'cctv');
      await tester.enterText(find.byKey(JoinScreen.pinFieldKey), '004201');
      await tester.tap(find.byKey(JoinScreen.submitKey));
      await tester.pumpAndSettle();
      // The submitted identity must be the persisted installation id: minting
      // a fresh id per submit would fail this equality check.
      final String? stored = (await SharedPreferences.getInstance()).getString(
        DeviceIdentityStore.storageKey,
      );
      expect(stored, matches(RegExp(r'^p-[0-9a-f]{32}$')));
      expect(received?.deviceId.value, stored);
      expect(received?.joinPin, '004201');
      received = null;
      await tester.enterText(
        find.byKey(JoinScreen.payloadFieldKey),
        '{"partyId":"paste","channelId":"cctv","deviceId":"evil"}',
      );
      await tester.tap(find.byKey(JoinScreen.submitKey));
      await tester.pumpAndSettle();
      expect(received?.partyId.value, 'paste');
      expect(received?.deviceId.value, isNot('evil'));
      expect(received?.deviceId.value, stored);
    },
  );
  testWidgets('invalid input is blocked', (tester) async {
    SharedPreferences.setMockInitialValues({});
    var called = false;
    await tester.pumpWidget(
      MaterialApp(
        home: JoinScreen(
          onJoin: (_) async {
            called = true;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(JoinScreen.partyFieldKey), 'bad/path');
    await tester.enterText(find.byKey(JoinScreen.channelFieldKey), 'c');
    await tester.tap(find.byKey(JoinScreen.submitKey));
    await tester.pumpAndSettle();
    expect(called, isFalse);
    expect(find.byKey(JoinScreen.errorKey), findsOneWidget);
  });
  testWidgets(
    'scan and submit stay disabled until the device identity is ready',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
      final Completer<SharedPreferences> gate = Completer<SharedPreferences>();
      await tester.pumpWidget(
        MaterialApp(
          home: JoinScreen(
            identityStore: DeviceIdentityStore(preferences: () => gate.future),
            onJoin: (_) async {},
          ),
        ),
      );
      await tester.pump();
      expect(
        tester.widget<TextButton>(find.byKey(JoinScreen.scanKey)).onPressed,
        isNull,
      );
      expect(
        tester
            .widget<ElevatedButton>(find.byKey(JoinScreen.submitKey))
            .onPressed,
        isNull,
      );
      expect(find.text('Preparing this device…'), findsOneWidget);
      gate.complete(await SharedPreferences.getInstance());
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextButton>(find.byKey(JoinScreen.scanKey)).onPressed,
        isNotNull,
      );
      expect(
        tester
            .widget<ElevatedButton>(find.byKey(JoinScreen.submitKey))
            .onPressed,
        isNotNull,
      );
    },
  );
  testWidgets('overlapping scans never run concurrently', (tester) async {    SharedPreferences.setMockInitialValues({});
    final Completer<JoinPayloadScanResult> gate =
        Completer<JoinPayloadScanResult>();
    final _CountingScanner scanner = _CountingScanner(pending: gate.future);
    await tester.pumpWidget(
      MaterialApp(
        home: JoinScreen(scanner: scanner, onJoin: (_) async {}),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(JoinScreen.scanKey));
    await tester.pump();
    expect(scanner.calls, 1);
    expect(
      tester.widget<TextButton>(find.byKey(JoinScreen.scanKey)).onPressed,
      isNull,
    );
    await tester.tap(find.byKey(JoinScreen.scanKey));
    await tester.pump();
    expect(scanner.calls, 1);
    gate.complete(const JoinPayloadUnavailable());
    await tester.pumpAndSettle();
    expect(scanner.calls, 1);
    expect(find.text('Scanner is unavailable on this device.'), findsOneWidget);
    expect(
      tester.widget<TextButton>(find.byKey(JoinScreen.scanKey)).onPressed,
      isNotNull,
    );
  });
  testWidgets('a host invitation on the guest form fails visibly without joining', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    var called = false;
    await tester.pumpWidget(
      MaterialApp(
        home: JoinScreen(
          onJoin: (_) async {
            called = true;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(JoinScreen.payloadFieldKey),
      '{"partyId":"party","channelId":"cctv","role":"host",'
      '"inviteToken":"hi-abcdef0123456789abcdef0123456789abcdef01"}',
    );
    await tester.tap(find.byKey(JoinScreen.submitKey));
    await tester.pumpAndSettle();
    // Guest entry never registers a host payload through joinParty.
    expect(called, isFalse);
    expect(find.byKey(JoinScreen.errorKey), findsOneWidget);
    expect(find.textContaining('host entry'), findsOneWidget);
  });
  testWidgets('back returns to the host entry when provided', (tester) async {
    SharedPreferences.setMockInitialValues({});
    var backed = false;
    await tester.pumpWidget(
      MaterialApp(
        home: JoinScreen(
          onJoin: (_) async {},
          onBack: () => backed = true,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(backed, isTrue);
  });
}
