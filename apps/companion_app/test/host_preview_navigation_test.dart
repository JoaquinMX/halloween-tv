// Phone navigator-scope regression (physical proof blocker).
//
// Pumps the REAL standalone CompanionApp with fakes (no nested Navigator
// fakes) and taps the actual View / Attach-source-photo buttons, asserting
// the real pushed screens appear. Only the callable invoker boundaries and
// the Firebase bootstrap are substituted. No live calls, no network traffic.
import 'package:companion_app/src/companion_app.dart';
import 'package:companion_app/src/config/backend_config.dart';
import 'package:companion_app/src/data/host_join_client.dart';
import 'package:companion_app/src/data/host_media_client.dart';
import 'package:companion_app/src/data/party_join_client.dart';
import 'package:companion_app/src/join/device_identity_store.dart';
import 'package:companion_app/src/ui/guest_photo_screen.dart';
import 'package:companion_app/src/ui/host_entry_screen.dart';
import 'package:companion_app/src/ui/host_panel_screen.dart';
import 'package:companion_app/src/ui/host_video_preview_screen.dart';
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

Map<String, Object?> seedJson(String id, String status) => <String, Object?>{
  'seedId': id,
  'partyId': 'party-1',
  'channelId': 'cctv',
  'status': status,
  'jobId': 'hv-$id',
  'createdAt': '2026-10-29T14:00:00.000Z',
  'expiresAt': '2030-01-01T00:00:00.000Z',
  'previewAvailable': status == 'ready',
  'cameraIds': const <String>['CAM-01', 'CAM-02', 'CAM-03', 'CAM-04'],
};

final class FakeHostJoinInvoker implements HostJoinCallableInvoker {
  int calls = 0;
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    calls++;
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
  int previews = 0;
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    if (name == kListHostVideos) {
      return <String, Object?>{
        'videos': <Object?>[seedJson('nav-1', 'ready')],
      };
    }
    if (name == kGetHostVideoPreview) {
      previews++;
      final String seedId = payload['seedId'] as String;
      return <String, Object?>{
        'seedId': seedId,
        'expiresAt': '2030-01-01T00:00:00.000Z',
        'clips': <Object?>[
          for (final String camera in <String>[
            'CAM-01',
            'CAM-02',
            'CAM-03',
            'CAM-04',
          ])
            <String, Object?>{
              'cameraId': camera,
              'sha256': List<String>.filled(64, 'a').join(),
              'url': 'https://preview.example/$seedId/$camera.mp4',
              'expiresAt': '2030-01-01T00:00:00.000Z',
            },
        ],
      };
    }
    throw StateError('unexpected callable $name');
  }
}

final class FakeJoinInvoker implements PartyJoinCallableInvoker {
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
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

Future<void> pumpNavApp(WidgetTester tester) async {
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
      partyJoinInvokerOverride: FakeJoinInvoker(),
      hostJoinInvokerOverride: FakeHostJoinInvoker(),
      hostMediaInvokerOverride: FakeHostMediaInvoker(),
      clock: const SystemClock(),
    ),
  );
  await flush(tester);
}

Future<void> joinAsHost(WidgetTester tester) async {
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
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('tapping View pushes the real HostVideoPreviewScreen', (
    tester,
  ) async {
    await pumpNavApp(tester);
    await joinAsHost(tester);
    expect(find.byKey(HostPanelScreen.viewKey('nav-1')), findsOneWidget);

    await tapVisible(tester, find.byKey(HostPanelScreen.viewKey('nav-1')));
    await tester.pumpAndSettle();

    // The real preview screen opens on the app-owned navigator: no
    // above-MaterialApp FlutterError, and the fresh scoped capability
    // resolves into real camera rows.
    expect(find.byType(HostVideoPreviewScreen), findsOneWidget);
    expect(
      find.byKey(HostVideoPreviewScreen.playKey('CAM-01')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('host photo entry pushes the real GuestPhotoScreen', (
    tester,
  ) async {
    await pumpNavApp(tester);
    await joinAsHost(tester);
    expect(find.text('Attach source photo'), findsOneWidget);

    await tapVisible(tester, find.text('Attach source photo'));
    await tester.pumpAndSettle();

    expect(find.byType(GuestPhotoScreen), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
