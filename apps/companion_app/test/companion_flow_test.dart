// Companion join -> now-playing widget flow.
//
// Exercises the REAL parser (p3 guest_join_data), session (p3
// GuestSession), and manifest-mapping path (core_playlist cctvSlots /
// resolveCctvLabel / publishedAt). ONLY the callable boundary is
// substituted: a fake of the `ManifestSource<PlaybackManifest>` port
// (never the concrete connection, never Firebase).
//
// No Firebase initialization, no network traffic.

import 'dart:async';

import 'package:channel_api/channel_api.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:companion_app/src/companion_app.dart';
import 'package:companion_app/src/config/backend_config.dart';
import 'package:companion_app/src/data/party_join_client.dart';
import 'package:companion_app/src/join/device_identity_store.dart';
import 'package:companion_app/src/ui/connection_status.dart';
import 'package:companion_app/src/ui/join_screen.dart';
import 'package:companion_app/src/ui/now_playing_screen.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_firestore/infra_firestore.dart'
    show FirebaseManifestCallableInvoker;
import 'package:shared_preferences/shared_preferences.dart';

/// Port-level fake: substitutes only the callable-boundary source.
final class FakeManifestSource implements ManifestSource<PlaybackManifest> {
  FakeManifestSource();

  int watchCalls = 0;
  final List<StreamController<PlaybackManifest>> controllers =
      <StreamController<PlaybackManifest>>[];

  @override
  Stream<PlaybackManifest> watchCurrent({
    required String partyId,
    required String channelId,
  }) {
    watchCalls++;
    final StreamController<PlaybackManifest> controller =
        StreamController<PlaybackManifest>();
    controllers.add(controller);
    return controller.stream;
  }
}

/// Records live-boot callable traffic in [events] (`register` before
/// `manifest` proves the registration-before-subscription wiring).
///
/// When [failAfterFirst] is set, the first call serves [document] and later
/// calls throw: the transport treats the first failure as terminal
/// (`maxConsecutiveFailures: 0`), closes its stream, and the whole
/// subscription chain ends on its own — so no poll timer is left pending at
/// teardown (cancelling a chain parked in `await for` never completes).
final class RecordingManifestInvoker
    implements FirebaseManifestCallableInvoker {
  RecordingManifestInvoker(this.events, this.document);

  final List<String> events;
  final Map<String, Object?> document;
  int calls = 0;
  bool failAfterFirst = false;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    calls++;
    events.add('manifest');
    if (failAfterFirst && calls > 1) {
      throw Exception('scripted post-first callable failure');
    }
    return Map<String, Object?>.of(document);
  }
}

/// Fake joinParty boundary: echoes the requested scope into a valid guest
/// registration, or throws [failure] to script denial paths.
final class RecordingJoinInvoker implements PartyJoinCallableInvoker {
  RecordingJoinInvoker(this.events);

  final List<String> events;
  Object? failure;
  int calls = 0;
  Map<String, Object?>? lastPayload;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    calls++;
    events.add('register');
    lastPayload = Map<String, Object?>.of(payload);
    final Object? error = failure;
    if (error != null) {
      throw error;
    }
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

/// Controllable clock for last-successful-check timestamps.
final class FakeClock implements Clock {
  FakeClock(this.current);

  DateTime current;

  @override
  DateTime now() => current;
}

PlaybackManifest makeManifest({int version = 1, String partyId = 'party-1'}) {
  String sha(String seed) => List.filled(64, seed).join();
  return PlaybackManifest(
    partyId: partyId,
    channelId: 'cctv',
    version: version,
    clips: <ClipDescriptor>[
      for (int i = 1; i <= 4; i++)
        ClipDescriptor(
          id: 'clip-$i',
          cameraId: 'CAM-0$i',
          storageObjectId: 'cctv/cam-0$i.mp4',
          sha256: sha('$i'),
          sizeBytes: 1024,
          duration: const Duration(seconds: 8),
          mimeType: 'video/mp4',
        ),
    ],
    publishedAt: DateTime.utc(2026, 10, 29, 14),
  );
}

/// Flushes async stream delivery + StreamBuilder rebuilds without
/// pumpAndSettle (spinners schedule endless frames, so fixed pumps only).
Future<void> flush(WidgetTester tester) async {
  for (int i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

/// Fixed phone-shaped local identity used by the join form in every flow
/// test (the form persists/generates this through [DeviceIdentityStore]).
const String kFixedDeviceId = 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

Future<void> pumpApp(
  WidgetTester tester,
  FakeManifestSource source,
  FakeClock clock,
) async {
  SharedPreferences.setMockInitialValues(<String, Object>{
    DeviceIdentityStore.storageKey: kFixedDeviceId,
  });
  await tester.pumpWidget(CompanionApp(manifestSource: source, clock: clock));
  await flush(tester);
}

/// Scrolls [finder] into view, then enters [text] (the join form scrolls
/// inside the 800x600 test viewport).
Future<void> enterVisible(
  WidgetTester tester,
  Finder finder,
  String text,
) async {
  await tester.ensureVisible(finder);
  await tester.pump(const Duration(milliseconds: 50));
  await tester.enterText(finder, text);
}

/// Scrolls [finder] into view, then taps it.
///
/// [ensureVisible] alone can park a bottom-edge target exactly on the
/// viewport boundary (where hit-testing misses), so a nudge follows — via
/// [ScrollPosition.jumpTo], which never flings and never involves the
/// gesture arena (a test [drag] carries unrealistic velocity whose
/// ballistic flight would swallow the tap instead of pressing the button).
Future<void> tapVisible(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pump(const Duration(milliseconds: 50));
  final ScrollableState scrollable = tester.state<ScrollableState>(
    find.byType(Scrollable).first,
  );
  final Rect rect = tester.getRect(finder);
  final double viewHeight =
      tester.view.physicalSize.height / tester.view.devicePixelRatio;
  final double pixels = scrollable.position.pixels;
  final double max = scrollable.position.maxScrollExtent;
  if (rect.bottom > viewHeight - 4.0) {
    final double delta = rect.bottom - viewHeight + 80.0;
    scrollable.position.jumpTo((pixels + delta).clamp(0.0, max).toDouble());
    await tester.pump(const Duration(milliseconds: 50));
  } else if (rect.top < 0.0) {
    scrollable.position.jumpTo(
      (pixels + rect.top - 80.0).clamp(0.0, max).toDouble(),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
  await tester.tap(finder);
}

/// True when the current keyboard focus sits inside the widget with [key].
///
/// Walks up from [FocusManager.primaryFocus]: the [Focus] node owned by a
/// [TextField] or button lives below the keyed widget, so [Focus.of] on the
/// keyed element itself cannot see it.
bool focusIsOn(Key key) {
  final BuildContext? context = FocusManager.instance.primaryFocus?.context;
  if (context == null) {
    return false;
  }
  bool found = false;
  (context as Element).visitAncestorElements((Element ancestor) {
    if (ancestor.widget.key == key) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

Future<void> joinAs(
  WidgetTester tester,
  FakeManifestSource source, {
  String party = 'party-1',
  String channel = 'cctv',
  String pin = '',
}) async {
  await enterVisible(tester, find.byKey(JoinScreen.partyFieldKey), party);
  await enterVisible(tester, find.byKey(JoinScreen.channelFieldKey), channel);
  await enterVisible(tester, find.byKey(JoinScreen.pinFieldKey), pin);
  await tapVisible(tester, find.byKey(JoinScreen.submitKey));
  await flush(tester);
  expect(source.watchCalls, 1);
}

void main() {
  late FakeManifestSource source;
  late FakeClock clock;

  setUp(() {
    source = FakeManifestSource();
    clock = FakeClock(DateTime.utc(2026, 10, 29, 12));
  });

  tearDown(() async {
    for (final StreamController<PlaybackManifest> controller
        in source.controllers) {
      if (!controller.isClosed) {
        await controller.close();
      }
    }
  });

  group('Companion flow', () {
    testWidgets('join renders the published four-camera lineup in wall order', (
      WidgetTester tester,
    ) async {
      await pumpApp(tester, source, clock);
      await joinAs(tester, source);

      source.controllers.single.add(makeManifest(version: 7));
      await flush(tester);

      expect(find.text("The party's latest published lineup"), findsOneWidget);
      expect(find.textContaining('Manifest version 7'), findsOneWidget);
      expect(find.textContaining('2026-10-29'), findsWidgets);
      expect(find.textContaining('(UTC)'), findsWidgets);
      expect(find.textContaining('Last successful check'), findsOneWidget);
      expect(find.textContaining('Server publication time'), findsOneWidget);
      // No claim of TV playback sync anywhere on the lineup screen.
      expect(find.textContaining('playback sync'), findsNothing);

      const List<String> expected = <String>[
        'CAM-01 · hallway',
        'CAM-02 · kitchen',
        'CAM-03 · staircase',
        'CAM-04 · storage room',
      ];
      for (final String label in expected) {
        expect(find.text(label), findsOneWidget);
      }
      final List<double> tops = <double>[
        for (final String label in expected)
          tester.getTopLeft(find.text(label)).dy,
      ];
      for (int i = 0; i + 1 < tops.length; i++) {
        expect(tops[i] < tops[i + 1], isTrue);
      }
      expect(tester.takeException(), isNull);
    });

    testWidgets('invalid identifiers show inline errors and never join', (
      WidgetTester tester,
    ) async {
      await pumpApp(tester, source, clock);

      await enterVisible(
        tester,
        find.byKey(JoinScreen.partyFieldKey),
        'party/1',
      );
      await enterVisible(
        tester,
        find.byKey(JoinScreen.channelFieldKey),
        'cctv',
      );
      await enterVisible(tester, find.byKey(JoinScreen.pinFieldKey), '');
      await tapVisible(tester, find.byKey(JoinScreen.submitKey));
      await flush(tester);

      expect(find.byKey(JoinScreen.errorKey), findsOneWidget);
      expect(source.watchCalls, 0);
      expect(find.byKey(JoinScreen.submitKey), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a pasted join payload joins through the real payload parser', (
      WidgetTester tester,
    ) async {
      await pumpApp(tester, source, clock);

      await enterVisible(
        tester,
        find.byKey(JoinScreen.payloadFieldKey),
        '{"partyId": "party-1", "channelId": "cctv", "joinPin": "004201", '
        '"deviceId": "evil-device", "backend": "https://evil.example", '
        '"autoSubmit": true}',
      );
      await tapVisible(tester, find.byKey(JoinScreen.submitKey));
      await flush(tester);

      expect(source.watchCalls, 1);
      source.controllers.single.add(makeManifest(version: 2));
      await flush(tester);

      expect(find.textContaining('Manifest version 2'), findsOneWidget);
      expect(find.text('CAM-01 · hallway'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('server denial renders the denied state with no lineup', (
      WidgetTester tester,
    ) async {
      await pumpApp(tester, source, clock);
      await joinAs(tester, source);

      source.controllers.single.addError(
        FirebaseFunctionsException(
          code: 'permission-denied',
          message: 'unregistered party/device secret-party-9',
          details: const <String, Object?>{'errorCode': 'FORBIDDEN'},
        ),
      );
      await flush(tester);

      expect(find.text('Access was denied.'), findsOneWidget);
      expect(find.text('CAM-01 · hallway'), findsNothing);
      expect(find.textContaining('Manifest version'), findsNothing);
      // Raw backend detail never reaches a rendered banner.
      expect(find.textContaining('secret-party-9'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('malformed data renders the invalid-data state', (
      WidgetTester tester,
    ) async {
      await pumpApp(tester, source, clock);
      await joinAs(tester, source);

      source.controllers.single.addError(
        const FormatException('bad manifest envelope'),
      );
      await flush(tester);

      expect(find.text('The lineup data was invalid.'), findsOneWidget);
      expect(find.text('CAM-01 · hallway'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('stale lineup stays visible and retry recovers', (
      WidgetTester tester,
    ) async {
      await pumpApp(tester, source, clock);
      await joinAs(tester, source);

      source.controllers.single.add(makeManifest(version: 3));
      await flush(tester);
      expect(find.textContaining('Manifest version 3'), findsOneWidget);

      source.controllers.single.addError(Exception('socket closed'));
      await flush(tester);

      // Stale: last-known lineup retained with an explicit stale banner.
      expect(find.textContaining('Manifest version 3'), findsOneWidget);
      expect(
        find.text('Connection lost — showing last-known lineup.'),
        findsOneWidget,
      );

      final int callsBeforeRetry = source.watchCalls;
      await tapVisible(tester, find.byKey(NowPlayingScreen.retryKey));
      // The session's cancel + re-subscribe needs real event-loop turns
      // here, which fixed pumps alone stall; drain them, then rebuild.
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 300)),
      );
      await flush(tester);
      expect(source.watchCalls, callsBeforeRetry + 1);
      expect(find.text('Refreshing lineup…'), findsOneWidget);

      await tester.runAsync(() async {
        source.controllers.last.add(makeManifest(version: 4));
        await Future<void>.delayed(const Duration(milliseconds: 300));
      });
      await flush(tester);
      expect(source.watchCalls, callsBeforeRetry + 1);
      expect(find.textContaining('Manifest version 4'), findsOneWidget);
      expect(find.text('CAM-04 · storage room'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('leave resets the flow to the join screen', (
      WidgetTester tester,
    ) async {
      await pumpApp(tester, source, clock);
      await joinAs(tester, source);

      source.controllers.single.add(makeManifest());
      await flush(tester);
      expect(find.text('CAM-01 · hallway'), findsOneWidget);

      await tapVisible(tester, find.byKey(NowPlayingScreen.leaveKey));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 300)),
      );
      await flush(tester);

      expect(find.byKey(JoinScreen.submitKey), findsOneWidget);
      expect(find.textContaining('organizer'), findsWidgets);
      expect(find.text('CAM-01 · hallway'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('narrow phone with enlarged text keeps the flow usable and '
        'keyboard-traversable', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 3.0;
      tester.platformDispatcher.textScaleFactorTestValue = 1.4;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
        tester.platformDispatcher.clearAllTestValues();
      });

      await pumpApp(tester, source, clock);

      // Keyboard traversal: touch-focus the first field, then Tab moves
      // focus through the manual fields in order, proving keyboard-only
      // guests can reach every input and the Join button.
      await tapVisible(tester, find.byKey(JoinScreen.partyFieldKey));
      await flush(tester);
      expect(focusIsOn(JoinScreen.partyFieldKey), isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await flush(tester);
      expect(focusIsOn(JoinScreen.channelFieldKey), isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await flush(tester);
      expect(focusIsOn(JoinScreen.pinFieldKey), isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await flush(tester);
      expect(focusIsOn(JoinScreen.payloadFieldKey), isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await flush(tester);
      expect(focusIsOn(JoinScreen.scanKey), isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await flush(tester);
      expect(focusIsOn(JoinScreen.submitKey), isTrue);

      await joinAs(tester, source);
      source.controllers.single.add(makeManifest(version: 5));
      await flush(tester);

      expect(find.textContaining('Manifest version 5'), findsOneWidget);
      expect(find.byKey(NowPlayingScreen.refreshKey), findsOneWidget);
      expect(find.byKey(NowPlayingScreen.leaveKey), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('desktop width renders the full lineup without overflow', (
      WidgetTester tester,
    ) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      await pumpApp(tester, source, clock);
      await joinAs(tester, source);
      source.controllers.single.add(makeManifest(version: 6));
      await flush(tester);

      expect(find.textContaining('Manifest version 6'), findsOneWidget);
      expect(find.text('CAM-01 · hallway'), findsOneWidget);
      expect(find.text('CAM-02 · kitchen'), findsOneWidget);
      expect(find.text('CAM-03 · staircase'), findsOneWidget);
      expect(find.text('CAM-04 · storage room'), findsOneWidget);
      expect(find.byKey(const Key('camera-CAM-01')), findsOneWidget);
      expect(find.byKey(ConnectionStatus.retryKey), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });

  group('Companion live-boot flow (config + invoker overrides)', () {
    late FakeClock liveClock;
    late List<String> events;
    late RecordingManifestInvoker manifestInvoker;
    late RecordingJoinInvoker joinInvoker;

    Map<String, Object?> liveManifestDoc() {
      String sha(String seed) => List.filled(64, seed).join();
      return <String, Object?>{
        'partyId': 'party-1',
        'channelId': 'cctv',
        'version': 1,
        'schemaVersion': 1,
        'jobId': 'job-1',
        'cameraClips': <Object?>[
          for (int i = 1; i <= 4; i++)
            <String, Object?>{
              'cameraId': 'CAM-0$i',
              'durationMs': 2000,
              'expiresAt': '2030-01-01T00:00:00.000Z',
              'objectPath':
                  'parties/party-1/channels/cctv/delivery/1/CAM-0$i.mp4',
              'sha256': sha('$i'),
              'sizeBytes': 1024 + i,
            },
        ],
        'createdAt': '2026-10-29T14:00:00.000Z',
        'expiresAt': '2030-01-01T00:00:00.000Z',
      };
    }

    Future<void> pumpLiveApp(WidgetTester tester) async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        DeviceIdentityStore.storageKey: kFixedDeviceId,
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
          partyJoinInvokerOverride: joinInvoker,
          clock: liveClock,
        ),
      );
      await flush(tester);
    }

    Future<void> joinLive(WidgetTester tester) async {
      await enterVisible(tester, find.byKey(JoinScreen.partyFieldKey), 'party-1');
      await enterVisible(tester, find.byKey(JoinScreen.channelFieldKey), 'cctv');
      await enterVisible(tester, find.byKey(JoinScreen.pinFieldKey), '');
      await tapVisible(tester, find.byKey(JoinScreen.submitKey));
      await flush(tester);
    }

    setUp(() {
      liveClock = FakeClock(DateTime.utc(2026, 10, 29, 12));
      events = <String>[];
      manifestInvoker = RecordingManifestInvoker(events, liveManifestDoc());
      joinInvoker = RecordingJoinInvoker(events);
    });

    testWidgets('registration precedes the manifest subscription', (
      WidgetTester tester,
    ) async {
      manifestInvoker.failAfterFirst = true;
      await pumpLiveApp(tester);
      await joinLive(tester);

      expect(joinInvoker.calls, 1);
      expect(joinInvoker.lastPayload, <String, Object?>{
        'partyId': 'party-1',
        'deviceId': kFixedDeviceId,
        'channelId': 'cctv',
      });
      expect(manifestInvoker.calls, 1);
      // Registration is wired before the first manifest read.
      expect(events, <String>['register', 'manifest']);

      await flush(tester);
      expect(find.textContaining('Manifest version 1'), findsOneWidget);
      expect(find.text('CAM-01 · hallway'), findsOneWidget);

      // Let the next poll fail: the transport closes its stream on the
      // first failure, so the subscription ends on its own with the
      // last-known lineup retained and no poll timer pending at teardown.
      await tester.pump(const Duration(seconds: 31));
      await flush(tester);
      expect(manifestInvoker.calls, 2);
      expect(find.textContaining('Manifest version 1'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a FORBIDDEN registration surfaces the denied state', (
      WidgetTester tester,
    ) async {
      joinInvoker.failure = FirebaseFunctionsException(
        code: 'permission-denied',
        message: 'unregistered party/device secret-party-9',
        details: const <String, Object?>{'errorCode': 'FORBIDDEN'},
      );
      await pumpLiveApp(tester);
      await joinLive(tester);

      expect(joinInvoker.calls, 1);
      expect(manifestInvoker.calls, 0);
      expect(find.text('Access was denied.'), findsOneWidget);
      expect(find.text('CAM-01 · hallway'), findsNothing);
      // Raw backend detail never reaches a rendered banner.
      expect(find.textContaining('secret-party-9'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });
}
