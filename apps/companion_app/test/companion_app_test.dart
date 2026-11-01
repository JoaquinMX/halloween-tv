// Companion app end-to-end host pairing-code wiring (phone host-join fix).
//
// Exercises the REAL CompanionApp routing + REAL HostSession + REAL
// HostJoinClient/HostMediaClient; only the callable invoker boundaries and
// the Firebase bootstrap are faked. No live calls, no network traffic.
import 'package:companion_app/src/companion_app.dart';
import 'package:companion_app/src/config/backend_config.dart';
import 'package:companion_app/src/data/host_join_client.dart';
import 'package:companion_app/src/data/host_media_client.dart';
import 'package:companion_app/src/data/party_join_client.dart';
import 'package:companion_app/src/join/device_identity_store.dart';
import 'package:companion_app/src/ui/host_entry_screen.dart';
import 'package:companion_app/src/ui/host_panel_screen.dart';
import 'package:core_foundation/core_foundation.dart' show SystemClock;
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_firestore/infra_firestore.dart'
    show FirebaseManifestCallableInvoker;
import 'package:shared_preferences/shared_preferences.dart';

const String kGuestDeviceId = 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const String kHostDeviceId = 'p-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const String kHostToken =
    'hi-0123456789abcdef0123456789abcdef0123456789abcdef01';

String hostPayload() =>
    '{"partyId":"party-1","channelId":"cctv","role":"host",'
    '"inviteToken":"$kHostToken","pairingCode":"123456"}';

final class FakeHostJoinInvoker implements HostJoinCallableInvoker {
  int calls = 0;
  Map<String, Object?>? lastPayload;
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    calls++;
    lastPayload = Map<String, Object?>.of(payload);
    return <String, Object?>{
      'partyId': payload['partyId'],
      'deviceId': payload['deviceId'],
      'channelId': payload['channelId'],
      'role': 'host',
      'status': 'active',
      'created': true,
    };
  }
}

final class FakeHostMediaInvoker implements HostMediaCallableInvoker {
  final List<Map<String, Object?>> payloads = <Map<String, Object?>>[];
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    if (name == kListHostVideos) {
      return const <String, Object?>{'videos': <Object?>[]};
    }
    payloads.add(Map<String, Object?>.of(payload));
    throw StateError('unexpected callable $name');
  }
}

final class FakeJoinInvoker implements PartyJoinCallableInvoker {
  int calls = 0;
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    calls++;
    return <String, Object?>{
      'partyId': payload['partyId'],
      'deviceId': payload['deviceId'],
      'channelId': payload['channelId'],
      'role': 'guest',
      'status': 'active',
      'created': true,
    };
  }
}

final class FakeManifestInvoker implements FirebaseManifestCallableInvoker {
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async =>
      throw UnimplementedError();
}

Future<void> flush(WidgetTester tester) async {
  for (int i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Future<void> enterVisible(
  WidgetTester tester,
  Finder finder,
  String text,
) async {
  await tester.ensureVisible(finder);
  await tester.pump(const Duration(milliseconds: 50));
  await tester.enterText(finder, text);
}

Future<void> tapVisible(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pump(const Duration(milliseconds: 50));
  await tester.tap(finder);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('typed pairing code threads end-to-end into redeem', (
    tester,
  ) async {
    final FakeHostJoinInvoker joinInvoker = FakeHostJoinInvoker();
    final FakeHostMediaInvoker mediaInvoker = FakeHostMediaInvoker();
    final FakeJoinInvoker guestJoinInvoker = FakeJoinInvoker();
    SharedPreferences.setMockInitialValues(<String, Object>{
      DeviceIdentityStore.storageKey: kGuestDeviceId,
      DeviceIdentityStore.hostStorageKey: kHostDeviceId,
    });
    await tester.pumpWidget(
      CompanionApp(
        config: BackendConfig.parse(<String, Object?>{
          'apiKey': 'test-api-key',
          'appId': '1:123:android:abc',
          'projectId': 'test-project',
        }),
        firebaseBootstrap: (_) async {},
        invokerOverride: FakeManifestInvoker(),
        partyJoinInvokerOverride: guestJoinInvoker,
        hostJoinInvokerOverride: joinInvoker,
        hostMediaInvokerOverride: mediaInvoker,
        clock: const SystemClock(),
      ),
    );
    await flush(tester);

    await enterVisible(
      tester,
      find.byKey(HostEntryScreen.payloadFieldKey),
      hostPayload(),
    );
    await enterVisible(
      tester,
      find.byKey(HostEntryScreen.pairingCodeFieldKey),
      '123456',
    );
    await tapVisible(tester, find.byKey(HostEntryScreen.submitKey));
    await flush(tester);

    expect(find.byType(HostPanelScreen), findsOneWidget);
    expect(joinInvoker.calls, 1);
    expect(joinInvoker.lastPayload?['pairingCode'], '123456');
    expect(joinInvoker.lastPayload?['inviteToken'], kHostToken);
    expect(guestJoinInvoker.calls, 0);
    expect(tester.takeException(), isNull);
  });
}
