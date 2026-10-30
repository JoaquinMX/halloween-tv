import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:companion_app/src/join/join_payload_scanner.dart';
import 'package:companion_app/src/ui/join_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

final class _FakeScanner implements JoinPayloadScanner {
  _FakeScanner(this.result);
  final JoinPayloadScanResult result;
  @override
  Future<JoinPayloadScanResult> scan() async => result;
}

final class _FakePermissions implements CameraPermissionClient {
  _FakePermissions({required this.checkResult, this.requestResult});
  final CameraPermissionState checkResult;
  final CameraPermissionState? requestResult;
  int requests = 0;
  @override
  Future<CameraPermissionState> check() async => checkResult;
  @override
  Future<CameraPermissionState> request() async {
    requests++;
    return requestResult ?? checkResult;
  }
}

Future<void> _pumpJoin(WidgetTester tester, JoinPayloadScanner scanner, void Function(GuestJoinData data) onJoin) async {
  SharedPreferences.setMockInitialValues({});
  await tester.pumpWidget(MaterialApp(home: JoinScreen(scanner: scanner, onJoin: (data) async => onJoin(data))));
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('scanned QR text submits through the same validation as paste', (tester) async {
    GuestJoinData? received;
    await _pumpJoin(
      tester,
      _FakeScanner(const JoinPayloadText('{"partyId":"qr-party","channelId":"cctv","joinPin":"123456"}')),
      (data) => received = data,
    );
    await tester.tap(find.byKey(JoinScreen.scanKey));
    await tester.pumpAndSettle();
    expect(received?.partyId.value, 'qr-party');
    expect(received?.channelId, 'cctv');
    expect(received?.joinPin, '123456');
    expect(find.byKey(JoinScreen.errorKey), findsNothing);
  });

  testWidgets('scanned garbage surfaces the same parse error as pasted garbage', (tester) async {
    var called = false;
    await _pumpJoin(tester, _FakeScanner(const JoinPayloadText('{"nope":1}')), (_) => called = true);
    await tester.tap(find.byKey(JoinScreen.scanKey));
    await tester.pumpAndSettle();
    expect(called, isFalse);
    expect(find.byKey(JoinScreen.errorKey), findsOneWidget);
    expect(find.text('join payload must contain string partyId and channelId'), findsOneWidget);
  });

  testWidgets('camera denial is graceful and keeps the paste path usable', (tester) async {
    GuestJoinData? received;
    await _pumpJoin(tester, _FakeScanner(const JoinPayloadPermissionDenied()), (data) => received = data);
    await tester.tap(find.byKey(JoinScreen.scanKey));
    await tester.pumpAndSettle();
    expect(received, isNull);
    expect(
      find.text('Camera permission is needed to scan QR codes. Allow access and try again, or paste the join data instead.'),
      findsOneWidget,
    );
    // The paste path still works after the denial.
    await tester.enterText(find.byKey(JoinScreen.payloadFieldKey), '{"partyId":"paste","channelId":"cctv"}');
    await tester.ensureVisible(find.byKey(JoinScreen.submitKey));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(JoinScreen.submitKey));
    await tester.pumpAndSettle();
    expect(received?.partyId.value, 'paste');
  });

  testWidgets('permanent denial points at Settings', (tester) async {
    var called = false;
    await _pumpJoin(tester, _FakeScanner(const JoinPayloadPermissionDenied(permanently: true)), (_) => called = true);
    await tester.tap(find.byKey(JoinScreen.scanKey));
    await tester.pumpAndSettle();
    expect(called, isFalse);
    expect(find.textContaining('Settings'), findsOneWidget);
  });

  test('camera scanner returns denial without requesting twice or navigating', () async {
    // check() denied -> request() denied: surfaces a retryable denial.
    final retryable = _FakePermissions(
      checkResult: CameraPermissionState.denied,
      requestResult: CameraPermissionState.denied,
    );
    // (No navigation happens on denial paths.)
    final scanner = CameraJoinPayloadScanner(
      contextOf: () => throw StateError('must not need context on denial'),
      permissions: retryable,
    );
    final first = await scanner.scan();
    expect(first, isA<JoinPayloadPermissionDenied>());
    expect((first as JoinPayloadPermissionDenied).permanently, isFalse);
    expect(retryable.requests, 1);

    // check() permanently denied: never prompts, never navigates.
    final blocked = _FakePermissions(checkResult: CameraPermissionState.permanentlyDenied);
    final scanner2 = CameraJoinPayloadScanner(
      contextOf: () => throw StateError('must not need context on denial'),
      permissions: blocked,
    );
    final second = await scanner2.scan();
    expect(second, isA<JoinPayloadPermissionDenied>());
    expect((second as JoinPayloadPermissionDenied).permanently, isTrue);
    expect(blocked.requests, 0);
  });
}
