// Host-first navigation, role-aware joining, and video administration.
//
// Exercises the REAL parser (guest_join_data role validation), the REAL
// HostEntryScreen/JoinScreen routing, the REAL HostSession state machine,
// and REAL response validation (HostJoinClient/HostMediaClient). ONLY the
// platform/network boundaries are substituted: fake callable invokers
// (never the clients, never the session) and fake scanners. No Firebase
// initialization, no network traffic.

import 'dart:async';

import 'package:channel_api/channel_api.dart';
import 'package:cloud_functions/cloud_functions.dart' as cloud_functions;
import 'package:companion_app/src/companion_app.dart';
import 'package:companion_app/src/config/backend_config.dart';
import 'package:companion_app/src/data/host_join_client.dart';
import 'package:companion_app/src/data/host_media_client.dart';
import 'package:companion_app/src/data/party_join_client.dart';
import 'package:companion_app/src/join/device_identity_store.dart';
import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:companion_app/src/join/join_payload_scanner.dart';
import 'package:companion_app/src/session/host_session.dart';
import 'package:companion_app/src/ui/host_entry_screen.dart';
import 'package:companion_app/src/ui/host_panel_screen.dart';
import 'package:companion_app/src/ui/host_video_preview_screen.dart';
import 'package:companion_app/src/ui/join_screen.dart';
import 'package:core_foundation/core_foundation.dart'
    show Ok, Result, SystemClock;
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_firestore/infra_firestore.dart'
    show FirebaseManifestCallableInvoker, ManifestTransportException;
import 'package:shared_preferences/shared_preferences.dart';

const String kGuestDeviceId = 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const String kHostDeviceId = 'p-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const String kHostToken =
    'hi-0123456789abcdef0123456789abcdef0123456789abcdef01';

String hostPayload({
  String party = 'party-1',
  String channel = 'cctv',
  String token = kHostToken,
}) =>
    '{"partyId":"$party","channelId":"$channel","role":"host",'
    '"inviteToken":"$token"}';

GuestJoinData hostData({
  String party = 'party-1',
  String channel = 'cctv',
  String device = kHostDeviceId,
  String token = kHostToken,
}) {
  final Result<GuestJoinData> result = parseGuestJoinFields(
    partyId: party,
    localDeviceId: device,
    channelId: channel,
    role: JoinRole.host,
    inviteToken: token,
  );
  return (result as Ok<GuestJoinData>).value;
}

/// Fake joinHost boundary: echoes the requested scope into a valid host
/// registration, or throws [failure] to script denial paths.
final class FakeHostJoinInvoker implements HostJoinCallableInvoker {
  int calls = 0;
  Map<String, Object?>? lastPayload;
  Object? failure;
  Object? nextResponse;
  bool createdFirst = true;
  bool _created = false;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    calls++;
    lastPayload = Map<String, Object?>.of(payload);
    final Object? error = failure;
    if (error != null) throw error;
    if (name != kJoinHostCallable) throw StateError('unexpected $name');
    final Object? override = nextResponse;
    if (override != null) {
      nextResponse = null;
      return override;
    }
    final bool created = createdFirst && !_created;
    _created = true;
    return <String, Object?>{
      'partyId': payload['partyId'],
      'deviceId': payload['deviceId'],
      'channelId': payload['channelId'],
      'role': 'host',
      'status': 'active',
      'created': created,
    };
  }
}

/// Fake host-media boundary: backend-faithful seed catalog behavior.
final class FakeHostMediaInvoker implements HostMediaCallableInvoker {
  final List<String> names = <String>[];
  final List<Map<String, Object?>> payloads = <Map<String, Object?>>[];
  final List<Map<String, Object?>> seeds = <Map<String, Object?>>[];
  Object? failure;
  int previews = 0;

  static Map<String, Object?> seedJson(String id, String status) =>
      <String, Object?>{
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

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    names.add(name);
    payloads.add(Map<String, Object?>.of(payload));
    final Object? error = failure;
    if (error != null) throw error;
    switch (name) {
      case kListHostVideos:
        return <String, Object?>{
          'videos': <Object?>[
            for (final s in seeds) Map<String, Object?>.of(s),
          ],
        };
      case kGenerateHostVideo:
        final String seedId = payload['seedId'] as String;
        final bool exists = seeds.any((s) => s['seedId'] == seedId);
        if (!exists) {
          seeds.add(seedJson(seedId, 'queued'));
          return <String, Object?>{
            'seedId': seedId,
            'jobId': 'hv-$seedId',
            'state': 'queued',
            'created': true,
          };
        }
        return <String, Object?>{
          'seedId': seedId,
          'jobId': 'hv-$seedId',
          'state': 'queued',
          'created': false,
        };
      case kGetHostVideoPreview:
        previews++;
        final String seedId = payload['seedId'] as String;
        return <String, Object?>{
          'seedId': seedId,
          'expiresAt': '2030-01-01T00:00:00.000Z',
          'clips': <Object?>[
            for (final camera in ['CAM-01', 'CAM-02', 'CAM-03', 'CAM-04'])
              <String, Object?>{
                'cameraId': camera,
                'sha256': List.filled(64, 'a').join(),
                'url': 'https://preview.example/$seedId/$camera.mp4',
                'expiresAt': '2030-01-01T00:00:00.000Z',
              },
          ],
        };
      case kDeleteHostVideo:
        final List<String> ids = <String>[
          for (final Object? id in payload['seedIds'] as List) id.toString(),
        ];
        seeds.removeWhere((s) => ids.contains(s['seedId']));
        return <String, Object?>{
          'deletedSeedIds': ids,
          'deletedObjects': <String>[
            for (final id in ids) 'parties/party-1/hostPreviews/$id/CAM-01.mp4',
          ],
          'revokedManifest': true,
        };
    }
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

final class FakeManifestSource implements ManifestSource<PlaybackManifest> {
  @override
  Stream<PlaybackManifest> watchCurrent({
    required String partyId,
    required String channelId,
  }) => const Stream<PlaybackManifest>.empty();
}

final class FakeScanner implements JoinPayloadScanner {
  FakeScanner(this.result);
  final JoinPayloadScanResult result;
  @override
  Future<JoinPayloadScanResult> scan([BuildContext? context]) async => result;
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

  group('host session (real session, fake invoker boundary)', () {
    late FakeHostJoinInvoker joinInvoker;
    late FakeHostMediaInvoker mediaInvoker;
    final List<HostSession> sessions = <HostSession>[];

    HostSession openSession() {
      final HostSession session = HostSession(
        joinClient: HostJoinClient(invoker: joinInvoker),
        mediaClient: HostMediaClient(invoker: mediaInvoker),
      );
      sessions.add(session);
      return session;
    }

    setUp(() {
      joinInvoker = FakeHostJoinInvoker();
      mediaInvoker = FakeHostMediaInvoker()
        ..seeds.addAll(<Map<String, Object?>>[
          FakeHostMediaInvoker.seedJson('catalog-1', 'ready'),
          FakeHostMediaInvoker.seedJson('catalog-2', 'queued'),
        ]);
    });

    tearDown(() async {
      for (final HostSession session in sessions) {
        await session.dispose();
      }
      sessions.clear();
    });

    test('join validates scope and loads the catalog', () async {
      final HostSession session = openSession();
      await session.join(hostData());
      expect(session.state.status, HostSessionStatus.ready);
      expect(session.state.binding?.deviceId.value, kHostDeviceId);
      expect(session.videos.map((v) => '${v.seedId}:${v.status}'), <String>[
        'catalog-1:ready',
        'catalog-2:queued',
      ]);
      expect(joinInvoker.lastPayload, <String, Object?>{
        'partyId': 'party-1',
        'deviceId': kHostDeviceId,
        'channelId': 'cctv',
        'inviteToken': kHostToken,
      });
      expect(joinInvoker.lastPayload, isNot(contains('role')));
    });

    test('guest payloads never reach joinHost', () async {
      final HostSession session = openSession();
      final Result<GuestJoinData> parsed = parseGuestJoinPayload(
        '{"partyId":"party-1","channelId":"cctv"}',
        localDeviceId: kGuestDeviceId,
      );
      final GuestJoinData guest = (parsed as Ok<GuestJoinData>).value;
      await expectLater(session.join(guest), throwsA(isA<HostJoinException>()));
      expect(joinInvoker.calls, 0);
      expect(session.state.status, HostSessionStatus.idle);
    });

    test(
      'host denial surfaces the denied state with a sanitized message',
      () async {
        joinInvoker.failure = cloud_functions.FirebaseFunctionsException(
          code: 'permission-denied',
          message: 'raw backend detail must never surface',
          details: const <String, Object?>{'errorCode': 'FORBIDDEN'},
        );
        final HostSession session = openSession();
        await expectLater(
          session.join(hostData()),
          throwsA(
            predicate<HostJoinException>(
              (e) =>
                  e.message == 'Access was denied.' &&
                  !e.message.contains('raw backend'),
            ),
          ),
        );
        expect(session.state.status, HostSessionStatus.denied);
        expect(session.state.message, 'Access was denied.');
      },
    );

    test('scope mismatch fails visibly as invalid data', () async {
      joinInvoker.nextResponse = <String, Object?>{
        'partyId': 'other-party',
        'deviceId': kHostDeviceId,
        'channelId': 'cctv',
        'role': 'host',
        'status': 'active',
        'created': true,
      };
      final HostSession session = openSession();
      await expectLater(
        session.join(hostData()),
        throwsA(isA<HostJoinException>()),
      );
      expect(session.state.status, HostSessionStatus.invalidData);
    });

    test('generation retries reuse a stable idempotency key', () async {
      final HostSession session = openSession();
      await session.join(hostData());
      mediaInvoker.names.clear();
      mediaInvoker.payloads.clear();
      await session.generate('catalog-9');
      await session.generate('catalog-9');
      final List<String> keys = <String>[
        for (int i = 0; i < mediaInvoker.names.length; i++)
          if (mediaInvoker.names[i] == kGenerateHostVideo)
            mediaInvoker.payloads[i]['idempotencyKey'].toString(),
      ];
      expect(keys, hasLength(2));
      expect(keys[0], isNotEmpty);
      expect(keys[1], keys[0]);
    });

    test('delete reconciles only after authoritative success', () async {
      final HostSession session = openSession();
      await session.join(hostData());
      expect(session.videos.map((v) => v.seedId), <String>[
        'catalog-1',
        'catalog-2',
      ]);
      await session.deleteVideos(const <String>['catalog-1']);
      expect(session.videos.map((v) => v.seedId), <String>['catalog-2']);
      mediaInvoker.failure = cloud_functions.FirebaseFunctionsException(
        code: 'permission-denied',
        message: 'denied',
        details: const <String, Object?>{'errorCode': 'FORBIDDEN'},
      );
      await expectLater(
        session.deleteVideos(const <String>['catalog-2']),
        throwsA(isA<ManifestTransportException>()),
      );
      // Failure leaves the list untouched: still retryable.
      expect(session.videos.map((v) => v.seedId), <String>['catalog-2']);
    });

    test('leaving drops late responses from a superseded refresh', () async {
      final List<Completer<Map<String, Object?>>> gates =
          <Completer<Map<String, Object?>>>[
            Completer<Map<String, Object?>>(),
            Completer<Map<String, Object?>>(),
          ];
      int lists = 0;
      final HostSession session = HostSession(
        joinClient: HostJoinClient(invoker: joinInvoker),
        mediaClient: HostMediaClient(
          invoker: _QueuedListInvoker(mediaInvoker, gates, () => lists++),
        ),
      );
      sessions.add(session);
      final Future<void> joining = session.join(hostData());
      await Future<void>.delayed(Duration.zero);
      gates[0].complete(<String, Object?>{
        'videos': <Object?>[FakeHostMediaInvoker.seedJson('a', 'ready')],
      });
      await joining;
      expect(session.state.status, HostSessionStatus.ready);
      expect(session.videos.map((v) => v.seedId), <String>['a']);
      final Future<void> pending = session.refresh();
      await session.leave();
      gates[1].complete(<String, Object?>{'videos': <Object?>[]});
      await pending;
      await Future<void>.delayed(Duration.zero);
      expect(session.state.status, HostSessionStatus.idle);
      expect(session.videos, isEmpty);
      await session.dispose();
    });

    test('suspend stops polling and resume refreshes', () async {
      final HostSession session = openSession();
      await session.join(hostData());
      final int lists = mediaInvoker.names
          .where((n) => n == kListHostVideos)
          .length;
      await session.suspend();
      expect(session.state.status, HostSessionStatus.stale);
      expect(session.videos, hasLength(2));
      await session.resume();
      expect(
        mediaInvoker.names.where((n) => n == kListHostVideos).length,
        lists + 1,
      );
      expect(session.state.status, HostSessionStatus.ready);
    });
  });

  group('host entry screen (real parser, fake scanner boundary)', () {
    Future<void> pumpEntry(
      WidgetTester tester, {
      required void Function(GuestJoinData data) onHostJoin,
      JoinPayloadScanner scanner = const UnavailableJoinPayloadScanner(),
    }) async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        DeviceIdentityStore.hostStorageKey: kHostDeviceId,
        DeviceIdentityStore.storageKey: kGuestDeviceId,
      });
      await tester.pumpWidget(
        MaterialApp(
          home: HostEntryScreen(
            onHostJoin: (data) async => onHostJoin(data),
            onJoinAsGuest: () {},
            scanner: scanner,
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('boot offers scan, paste, retry, and a guest route', (
      tester,
    ) async {
      GuestJoinData? received;
      await pumpEntry(tester, onHostJoin: (data) => received = data);
      expect(find.byKey(HostEntryScreen.scanKey), findsOneWidget);
      expect(find.byKey(HostEntryScreen.payloadFieldKey), findsOneWidget);
      expect(find.byKey(HostEntryScreen.submitKey), findsOneWidget);
      expect(find.byKey(HostEntryScreen.joinAsGuestKey), findsOneWidget);
      expect(received, isNull);
      expect(tester.takeException(), isNull);
    });

    testWidgets('scan and paste reach the same host payload (parity)', (
      tester,
    ) async {
      GuestJoinData? scanned;
      await pumpEntry(
        tester,
        onHostJoin: (data) => scanned = data,
        scanner: FakeScanner(JoinPayloadText(hostPayload())),
      );
      await tester.tap(find.byKey(HostEntryScreen.scanKey));
      await tester.pumpAndSettle();

      GuestJoinData? pasted;
      await pumpEntry(tester, onHostJoin: (data) => pasted = data);
      await tester.enterText(
        find.byKey(HostEntryScreen.payloadFieldKey),
        hostPayload(),
      );
      await tester.tap(find.byKey(HostEntryScreen.submitKey));
      await tester.pumpAndSettle();

      expect(scanned, isNotNull);
      expect(pasted, isNotNull);
      expect(scanned, pasted);
      expect(scanned?.role, JoinRole.host);
      expect(scanned?.inviteToken, kHostToken);
      // The host phone identity is separate from the guest identity.
      expect(scanned?.deviceId.value, kHostDeviceId);
      expect(scanned?.deviceId.value, isNot(kGuestDeviceId));
      expect(tester.takeException(), isNull);
    });

    testWidgets('guest payloads fail visibly without network', (tester) async {
      var joined = false;
      await pumpEntry(
        tester,
        onHostJoin: (_) => joined = true,
        scanner: FakeScanner(
          const JoinPayloadText('{"partyId":"p","channelId":"c"}'),
        ),
      );
      await tester.tap(find.byKey(HostEntryScreen.scanKey));
      await tester.pumpAndSettle();
      expect(joined, isFalse);
      expect(find.byKey(HostEntryScreen.errorKey), findsOneWidget);
      expect(find.textContaining('Join as guest'), findsWidgets);
    });

    testWidgets('unknown roles fail visibly', (tester) async {
      var joined = false;
      await pumpEntry(tester, onHostJoin: (_) => joined = true);
      await tester.enterText(
        find.byKey(HostEntryScreen.payloadFieldKey),
        '{"partyId":"p","channelId":"c","role":"admin"}',
      );
      await tester.tap(find.byKey(HostEntryScreen.submitKey));
      await tester.pumpAndSettle();
      expect(joined, isFalse);
      expect(find.byKey(HostEntryScreen.errorKey), findsOneWidget);
      expect(
        tester.widget<Text>(find.byKey(HostEntryScreen.errorKey)).data,
        contains('unknown role'),
      );
    });

    testWidgets('legacy guest payloads route to the guest form, not host', (
      tester,
    ) async {
      GuestJoinData? received;
      SharedPreferences.setMockInitialValues(<String, Object>{
        DeviceIdentityStore.storageKey: kGuestDeviceId,
      });
      await tester.pumpWidget(
        MaterialApp(home: JoinScreen(onJoin: (data) async => received = data)),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(JoinScreen.payloadFieldKey),
        '{"partyId":"legacy","channelId":"cctv"}',
      );
      await tester.tap(find.byKey(JoinScreen.submitKey));
      await tester.pumpAndSettle();
      expect(received?.role, JoinRole.guest);
      expect(received?.partyId.value, 'legacy');
    });
  });

  group('host panel screen (real session, fake invoker boundary)', () {
    late FakeHostJoinInvoker joinInvoker;
    late FakeHostMediaInvoker mediaInvoker;

    Future<HostSession> joinedSession() async {
      final HostSession session = HostSession(
        joinClient: HostJoinClient(invoker: joinInvoker),
        mediaClient: HostMediaClient(invoker: mediaInvoker),
      );
      addTearDown(session.dispose);
      await session.join(hostData());
      return session;
    }

    Future<void> pumpPanel(
      WidgetTester tester,
      HostSession session, {
      void Function(String seedId)? onPreview,
    }) async {
      await tester.pumpWidget(
        MaterialApp(
          home: HostPanelScreen(
            session: session,
            onLeave: () async {},
            onPreview: onPreview ?? (_) {},
          ),
        ),
      );
      await flush(tester);
    }

    setUp(() {
      joinInvoker = FakeHostJoinInvoker();
      mediaInvoker = FakeHostMediaInvoker();
    });

    testWidgets('lists empty, queued, ready, failed, and deleted states', (
      tester,
    ) async {
      mediaInvoker.seeds.addAll(<Map<String, Object?>>[
        FakeHostMediaInvoker.seedJson('q', 'queued'),
        FakeHostMediaInvoker.seedJson('r', 'ready'),
        FakeHostMediaInvoker.seedJson('f', 'failed'),
        FakeHostMediaInvoker.seedJson('d', 'deleted'),
      ]);
      final HostSession session = await joinedSession();
      await pumpPanel(tester, session);
      expect(find.textContaining('q · Queued'), findsOneWidget);
      expect(find.textContaining('r · Ready'), findsOneWidget);
      expect(find.textContaining('f · Failed'), findsOneWidget);
      expect(find.textContaining('d · Deleted'), findsOneWidget);
      // Deleted seeds offer no actions; live ones offer view + delete.
      expect(find.byKey(HostPanelScreen.viewKey('d')), findsNothing);
      expect(find.byKey(HostPanelScreen.deleteKey('d')), findsNothing);
      expect(find.byKey(HostPanelScreen.viewKey('r')), findsOneWidget);
      expect(find.byKey(HostPanelScreen.deleteKey('r')), findsOneWidget);
      await session.dispose();
      await flush(tester);
      expect(tester.takeException(), isNull);
    });

    testWidgets('empty catalog explains itself and generates', (tester) async {
      final HostSession session = await joinedSession();
      await pumpPanel(tester, session);
      expect(find.byKey(HostPanelScreen.emptyKey), findsOneWidget);
      await enterVisible(
        tester,
        find.byKey(HostPanelScreen.generateSeedKey),
        'catalog-new',
      );
      await tapVisible(tester, find.byKey(HostPanelScreen.generateKey));
      await flush(tester);
      expect(find.textContaining('catalog-new · Queued'), findsOneWidget);
      expect(
        mediaInvoker.payloads
            .where((p) => p['seedId'] == 'catalog-new')
            .map((p) => p['presetId']),
        <String>[kCheapDemoPresetId],
      );
      await session.dispose();
      await flush(tester);
    });

    testWidgets('delete success reconciles; failure stays retryable', (
      tester,
    ) async {
      mediaInvoker.seeds.addAll(<Map<String, Object?>>[
        FakeHostMediaInvoker.seedJson('a', 'ready'),
        FakeHostMediaInvoker.seedJson('b', 'ready'),
      ]);
      final HostSession session = await joinedSession();
      await pumpPanel(tester, session);
      await tapVisible(tester, find.byKey(HostPanelScreen.deleteKey('a')));
      await flush(tester);
      expect(find.textContaining('a · Ready'), findsNothing);
      expect(find.textContaining('b · Ready'), findsOneWidget);
      mediaInvoker.failure = cloud_functions.FirebaseFunctionsException(
        code: 'permission-denied',
        message: 'denied',
        details: const <String, Object?>{'errorCode': 'FORBIDDEN'},
      );
      await tapVisible(tester, find.byKey(HostPanelScreen.deleteKey('b')));
      await flush(tester);
      expect(find.byKey(HostPanelScreen.messageKey), findsOneWidget);
      expect(find.textContaining('b · Ready'), findsOneWidget);
      await session.dispose();
      await flush(tester);
    });

    testWidgets('view opens the preview callback per seed', (tester) async {
      mediaInvoker.seeds.add(FakeHostMediaInvoker.seedJson('v', 'ready'));
      String? viewed;
      final HostSession session = await joinedSession();
      await pumpPanel(tester, session, onPreview: (seedId) => viewed = seedId);
      await tapVisible(tester, find.byKey(HostPanelScreen.viewKey('v')));
      await flush(tester);
      expect(viewed, 'v');
      await session.dispose();
      await flush(tester);
    });
  });

  group('host preview screen (real session, fake media boundary)', () {
    testWidgets('obtains a fresh capability and disposes playback resources', (
      tester,
    ) async {
      final FakeHostJoinInvoker joinInvoker = FakeHostJoinInvoker();
      final FakeHostMediaInvoker mediaInvoker = FakeHostMediaInvoker()
        ..seeds.add(FakeHostMediaInvoker.seedJson('v', 'ready'));
      final HostSession session = HostSession(
        joinClient: HostJoinClient(invoker: joinInvoker),
        mediaClient: HostMediaClient(invoker: mediaInvoker),
      );
      addTearDown(session.dispose);
      await session.join(hostData());
      final List<FakePreviewPlayer> players = <FakePreviewPlayer>[];

      await tester.pumpWidget(
        MaterialApp(
          home: HostVideoPreviewScreen(
            session: session,
            seedId: 'v',
            playerFactory: (url) {
              final FakePreviewPlayer player = FakePreviewPlayer(url);
              players.add(player);
              return player;
            },
          ),
        ),
      );
      await flush(tester);
      // Fresh scoped capability per view: exactly one preview call.
      expect(mediaInvoker.previews, 1);
      for (final camera in ['CAM-01', 'CAM-02', 'CAM-03', 'CAM-04']) {
        expect(
          find.byKey(HostVideoPreviewScreen.playKey(camera)),
          findsOneWidget,
        );
      }
      // Playing wires the real lifecycle: initialize -> play -> show.
      await tapVisible(
        tester,
        find.byKey(HostVideoPreviewScreen.playKey('CAM-01')),
      );
      await flush(tester);
      expect(players, hasLength(1));
      expect(players.single.initialized, isTrue);
      expect(players.single.playing, isTrue);
      expect(find.byKey(HostVideoPreviewScreen.videoKey), findsOneWidget);
      // Switching cameras disposes the previous player.
      await tapVisible(
        tester,
        find.byKey(HostVideoPreviewScreen.playKey('CAM-02')),
      );
      await flush(tester);
      expect(players, hasLength(2));
      expect(players.first.disposed, isTrue);
      expect(find.text('Playing'), findsOneWidget);
      // Leaving disposes playback resources without exceptions.
      await session.dispose();
      await tester.pumpWidget(const SizedBox());
      await flush(tester);
      expect(players.last.disposed, isTrue);
      expect(tester.takeException(), isNull);
      expect(mediaInvoker.previews, 1);
    });

    testWidgets('playback failure surfaces visibly and stays retryable', (
      tester,
    ) async {
      final FakeHostJoinInvoker joinInvoker = FakeHostJoinInvoker();
      final FakeHostMediaInvoker mediaInvoker = FakeHostMediaInvoker()
        ..seeds.add(FakeHostMediaInvoker.seedJson('v', 'ready'));
      final HostSession session = HostSession(
        joinClient: HostJoinClient(invoker: joinInvoker),
        mediaClient: HostMediaClient(invoker: mediaInvoker),
      );
      addTearDown(session.dispose);
      await session.join(hostData());

      await tester.pumpWidget(
        MaterialApp(
          home: HostVideoPreviewScreen(
            session: session,
            seedId: 'v',
            playerFactory: (_) => _FailingPreviewPlayer(),
          ),
        ),
      );
      await flush(tester);
      await tapVisible(
        tester,
        find.byKey(HostVideoPreviewScreen.playKey('CAM-01')),
      );
      await flush(tester);
      expect(find.byKey(HostVideoPreviewScreen.errorKey), findsOneWidget);
      expect(find.byKey(HostVideoPreviewScreen.videoKey), findsNothing);
      // Retryable: the camera row is still present.
      expect(
        find.byKey(HostVideoPreviewScreen.playKey('CAM-01')),
        findsOneWidget,
      );
      await session.dispose();
      await tester.pumpWidget(const SizedBox());
      await flush(tester);
      expect(tester.takeException(), isNull);
    });
  });

  group('companion app host flow (production-path routing)', () {
    late FakeHostJoinInvoker joinInvoker;
    late FakeHostMediaInvoker mediaInvoker;
    late FakeJoinInvoker guestJoinInvoker;
    late FakeManifestInvoker manifestInvoker;

    Future<void> pumpHostApp(WidgetTester tester) async {
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
          invokerOverride: manifestInvoker,
          partyJoinInvokerOverride: guestJoinInvoker,
          hostJoinInvokerOverride: joinInvoker,
          hostMediaInvokerOverride: mediaInvoker,
          clock: const SystemClock(),
        ),
      );
      await flush(tester);
    }

    setUp(() {
      joinInvoker = FakeHostJoinInvoker();
      mediaInvoker = FakeHostMediaInvoker()
        ..seeds.add(FakeHostMediaInvoker.seedJson('catalog-1', 'ready'));
      guestJoinInvoker = FakeJoinInvoker();
      manifestInvoker = FakeManifestInvoker();
    });

    testWidgets('host invite redeems into the panel only after validation', (
      tester,
    ) async {
      await pumpHostApp(tester);
      expect(find.byKey(HostEntryScreen.joinAsGuestKey), findsOneWidget);
      await enterVisible(
        tester,
        find.byKey(HostEntryScreen.payloadFieldKey),
        hostPayload(),
      );
      await tapVisible(tester, find.byKey(HostEntryScreen.submitKey));
      await flush(tester);
      // Scope validated -> panel with the server-backed catalog.
      expect(find.byType(HostPanelScreen), findsOneWidget);
      expect(find.textContaining('catalog-1 · Ready'), findsOneWidget);
      expect(guestJoinInvoker.calls, 0);
      expect(tester.takeException(), isNull);
    });

    testWidgets('host denial fails visibly on the entry screen', (
      tester,
    ) async {
      joinInvoker.failure = cloud_functions.FirebaseFunctionsException(
        code: 'permission-denied',
        message: 'raw detail must never surface',
        details: const <String, Object?>{'errorCode': 'FORBIDDEN'},
      );
      await pumpHostApp(tester);
      await enterVisible(
        tester,
        find.byKey(HostEntryScreen.payloadFieldKey),
        hostPayload(),
      );
      await tapVisible(tester, find.byKey(HostEntryScreen.submitKey));
      await flush(tester);
      expect(find.byType(HostPanelScreen), findsNothing);
      expect(find.byKey(HostEntryScreen.errorKey), findsOneWidget);
      expect(find.text('Access was denied.'), findsOneWidget);
      expect(find.textContaining('raw detail'), findsNothing);
    });

    testWidgets('guest payload on host entry never touches joinHost', (
      tester,
    ) async {
      await pumpHostApp(tester);
      await enterVisible(
        tester,
        find.byKey(HostEntryScreen.payloadFieldKey),
        '{"partyId":"party-1","channelId":"cctv"}',
      );
      await tapVisible(tester, find.byKey(HostEntryScreen.submitKey));
      await flush(tester);
      expect(joinInvoker.calls, 0);
      expect(find.byType(HostPanelScreen), findsNothing);
      expect(find.byKey(HostEntryScreen.errorKey), findsOneWidget);
    });

    testWidgets('leave returns to the dedicated entry', (tester) async {
      await pumpHostApp(tester);
      await enterVisible(
        tester,
        find.byKey(HostEntryScreen.payloadFieldKey),
        hostPayload(),
      );
      await tapVisible(tester, find.byKey(HostEntryScreen.submitKey));
      await flush(tester);
      expect(find.byType(HostPanelScreen), findsOneWidget);
      await tapVisible(tester, find.byKey(HostPanelScreen.leaveKey));
      await flush(tester);
      expect(find.byKey(HostEntryScreen.joinAsGuestKey), findsOneWidget);
      expect(find.byKey(HostEntryScreen.scanKey), findsOneWidget);
    });

    testWidgets('offline boot stays usable without network calls', (
      tester,
    ) async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      await tester.pumpWidget(const CompanionApp());
      await flush(tester);
      expect(find.byKey(HostEntryScreen.joinAsGuestKey), findsOneWidget);
      expect(find.byKey(HostEntryScreen.scanKey), findsOneWidget);
      // Submitting a host payload offline fails visibly, with no invoker
      // available and no network attempted.
      await enterVisible(
        tester,
        find.byKey(HostEntryScreen.payloadFieldKey),
        hostPayload(),
      );
      await tapVisible(tester, find.byKey(HostEntryScreen.submitKey));
      await flush(tester);
      expect(find.byKey(HostEntryScreen.errorKey), findsOneWidget);
      expect(find.byType(HostPanelScreen), findsNothing);
    });
  });
}

/// Fake platform player: substitutes ONLY the video_player boundary.
final class FakePreviewPlayer implements HostPreviewPlayer {
  FakePreviewPlayer(this.url);
  final Uri url;
  bool initialized = false;
  bool playing = false;
  bool disposed = false;

  @override
  Future<void> initialize() async {
    initialized = true;
  }

  @override
  Future<void> play() async {
    playing = true;
  }

  @override
  Future<void> pause() async {
    playing = false;
  }

  @override
  Future<void> dispose() async {
    disposed = true;
  }

  @override
  bool get isInitialized => initialized && !disposed;

  @override
  double get aspectRatio => 16 / 9;

  @override
  Widget buildView() => const SizedBox();
}

/// Player whose platform initialization always fails.
final class _FailingPreviewPlayer implements HostPreviewPlayer {
  @override
  Future<void> initialize() async {
    throw StateError('platform player unavailable');
  }

  @override
  Future<void> play() async {}

  @override
  Future<void> pause() async {}

  @override
  Future<void> dispose() async {}

  @override
  bool get isInitialized => false;

  @override
  double get aspectRatio => 16 / 9;

  @override
  Widget buildView() => const SizedBox();
}

/// Forwards list calls to queued gates so tests can interleave leave/refresh
/// and prove stale responses are dropped; every other callable delegates.
final class _QueuedListInvoker implements HostMediaCallableInvoker {
  _QueuedListInvoker(this._inner, this._gates, this._onList);
  final FakeHostMediaInvoker _inner;
  final List<Completer<Map<String, Object?>>> _gates;
  final void Function() _onList;
  int _lists = 0;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) {
    if (name == kListHostVideos) {
      _onList();
      return _gates[_lists++].future;
    }
    return _inner.call(name, payload);
  }
}
