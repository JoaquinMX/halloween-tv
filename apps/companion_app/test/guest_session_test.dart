// Guest session lifecycle tests: scoped-manifest joins, network
// loss/recovery, observation timestamps, denied/expired outcomes,
// cancellation, and party-switch races. Uses a minimal fake of the
// `ManifestSource` port bound to `PlaybackManifest`
// (never the concrete connection).

import 'dart:async';

import 'package:channel_api/channel_api.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:companion_app/src/session/guest_session.dart';
import 'package:companion_app/src/data/party_join_client.dart';
import 'package:companion_app/src/session/guest_session_state.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';

/// Minimal fake of the `ManifestSource` port bound to `PlaybackManifest`.
final class FakeManifestSource implements ManifestSource<PlaybackManifest> {
  FakeManifestSource();

  int watchCalls = 0;
  String? lastPartyId;
  String? lastChannelId;
  final List<StreamController<PlaybackManifest>> controllers =
      <StreamController<PlaybackManifest>>[];

  @override
  Stream<PlaybackManifest> watchCurrent({
    required String partyId,
    required String channelId,
  }) {
    watchCalls++;
    lastPartyId = partyId;
    lastChannelId = channelId;
    final StreamController<PlaybackManifest> controller =
        StreamController<PlaybackManifest>();
    controllers.add(controller);
    return controller.stream;
  }
}

/// Controllable clock for last-successful-check timestamps.
final class FakeClock implements Clock {
  FakeClock(this.current);

  DateTime current;

  @override
  DateTime now() => current;
}

final class FakeRegistrationInvoker implements PartyJoinCallableInvoker {
  FakeRegistrationInvoker(this.pending);
  final Completer<Object?> pending;
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) =>
      pending.future;
}

/// Join invoker serving one scripted step per call: a [Completer] waits, a
/// [Map] returns a valid echo, any other [Object] is thrown.
final class ScriptedJoinInvoker implements PartyJoinCallableInvoker {
  ScriptedJoinInvoker(this.steps);
  final List<Object?> steps;
  int calls = 0;
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    final Object? step = steps[calls++];
    if (step is Completer<Object?>) {
      return step.future;
    }
    if (step is Map<String, Object?>) {
      return <String, Object?>{
        'partyId': payload['partyId'],
        'deviceId': payload['deviceId'],
        'channelId': payload['channelId'],
        'role': 'guest',
        'status': 'active',
        'created': true,
      };
    }
    throw step!;
  }
}

PlaybackManifest makeManifest({
  String partyId = 'party-1',
  String channelId = 'cctv',
  int version = 1,
}) {
  String sha(String seed) => List.filled(64, seed).join();
  List<ClipDescriptor> clipsFor() => <ClipDescriptor>[
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
  ];
  return PlaybackManifest(
    partyId: partyId,
    channelId: channelId,
    version: version,
    clips: clipsFor(),
    publishedAt: DateTime.utc(2026, 10, 29),
  );
}

GuestJoinData joinFor({String party = 'party-1', String channel = 'cctv'}) {
  return GuestJoinData(
    partyId: PartyId(party),
    deviceId: DeviceId('device-9'),
    channelId: channel,
  );
}

/// Real-shaped backend failure: an SDK `FirebaseFunctionsException` whose
/// `details.errorCode` carries the backend contract code. Classification
/// must read the contract code — never substring-match error text.
FirebaseFunctionsException contractError(
  String sdkCode,
  String errorCode,
  String message,
) => FirebaseFunctionsException(
  code: sdkCode,
  message: message,
  details: <String, Object?>{'errorCode': errorCode},
);

/// Flushes async stream delivery.
Future<void> pumpEvents() async {
  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);
}

void main() {
  late FakeManifestSource source;
  late FakeClock clock;

  setUp(() {
    source = FakeManifestSource();
    clock = FakeClock(DateTime.utc(2026, 10, 29, 12));
  });

  tearDown(() async {
    for (final StreamController<PlaybackManifest> c in source.controllers) {
      if (!c.isClosed) {
        await c.close();
      }
    }
  });

  group('GuestSession', () {
    test(
      'registration completes before the first manifest subscription',
      () async {
        final Completer<Object?> registration = Completer<Object?>();
        final GuestSession session = GuestSession(
          source: source,
          clock: clock,
          joinClient: PartyJoinClient(
            invoker: FakeRegistrationInvoker(registration),
          ),
        );
        final Future<void> joining = session.join(joinFor());
        await pumpEvents();
        expect(session.state.status, GuestSessionStatus.loading);
        expect(source.watchCalls, 0);
        registration.complete(<String, Object?>{
          'partyId': 'party-1',
          'deviceId': 'device-9',
          'channelId': 'cctv',
          'role': 'guest',
          'status': 'active',
          'created': true,
        });
        await joining;
        expect(source.watchCalls, 1);
        expect(session.state.status, GuestSessionStatus.loading);
        source.controllers.single.add(makeManifest());
        await pumpEvents();
        expect(session.state.status, GuestSessionStatus.ready);
        await session.dispose();
      },
    );

    test(
      'leave during registration prevents an obsolete manifest read',
      () async {
        final Completer<Object?> registration = Completer<Object?>();
        final GuestSession session = GuestSession(
          source: source,
          clock: clock,
          joinClient: PartyJoinClient(
            invoker: FakeRegistrationInvoker(registration),
          ),
        );
        final Future<void> joining = session.join(joinFor());
        await pumpEvents();
        await session.leave();
        registration.complete(<String, Object?>{
          'partyId': 'party-1',
          'deviceId': 'device-9',
          'channelId': 'cctv',
          'role': 'guest',
          'status': 'active',
          'created': true,
        });
        await joining;
        expect(source.watchCalls, 0);
        expect(session.state.status, GuestSessionStatus.idle);
        await session.dispose();
      },
    );

    test(
      'switch during pending registration supersedes; late first registration never subscribes',
      () async {
        final Completer<Object?> first = Completer<Object?>();
        final Completer<Object?> second = Completer<Object?>();
        final ScriptedJoinInvoker invoker = ScriptedJoinInvoker(
          <Object?>[first, second],
        );
        final GuestSession session = GuestSession(
          source: source,
          clock: clock,
          joinClient: PartyJoinClient(invoker: invoker),
        );
        final Future<void> joiningFirst = session.join(
          joinFor(party: 'party-a'),
        );
        await pumpEvents();
        expect(session.state.status, GuestSessionStatus.loading);
        expect(invoker.calls, 1);

        final Future<void> joiningSecond = session.join(
          joinFor(party: 'party-b'),
        );
        await pumpEvents();
        expect(invoker.calls, 2);

        // The superseded first registration resolves late: it must never
        // start a manifest read for the abandoned party.
        first.complete(<String, Object?>{
          'partyId': 'party-a',
          'deviceId': 'device-9',
          'channelId': 'cctv',
          'role': 'guest',
          'status': 'active',
          'created': true,
        });
        await joiningFirst;
        expect(source.watchCalls, 0);
        expect(session.state.join?.partyId.value, 'party-b');

        second.complete(<String, Object?>{
          'partyId': 'party-b',
          'deviceId': 'device-9',
          'channelId': 'cctv',
          'role': 'guest',
          'status': 'active',
          'created': true,
        });
        await joiningSecond;
        expect(source.watchCalls, 1);
        expect(source.lastPartyId, 'party-b');
        source.controllers.single.add(makeManifest(partyId: 'party-b'));
        await pumpEvents();
        expect(session.state.status, GuestSessionStatus.ready);
        expect(session.manifest?.partyId, 'party-b');
        await session.dispose();
      },
    );

    test(
      'refresh while unregistered re-registers instead of subscribing',
      () async {
        final ScriptedJoinInvoker invoker = ScriptedJoinInvoker(
          <Object?>[
            contractError('permission-denied', 'FORBIDDEN', 'denied'),
            <String, Object?>{},
          ],
        );
        final GuestSession session = GuestSession(
          source: source,
          clock: clock,
          joinClient: PartyJoinClient(invoker: invoker),
        );
        await session.join(joinFor());
        expect(session.state.status, GuestSessionStatus.denied);
        expect(invoker.calls, 1);
        expect(source.watchCalls, 0);

        await session.refresh();
        expect(invoker.calls, 2);
        expect(source.watchCalls, 1);
        source.controllers.single.add(makeManifest());
        await pumpEvents();
        expect(session.state.status, GuestSessionStatus.ready);
        await session.dispose();
      },
    );
    test('starts idle with no manifest', () {
      final GuestSession session = GuestSession(source: source, clock: clock);
      expect(session.state.status, GuestSessionStatus.idle);
      expect(session.manifest, isNull);
      expect(session.joinData, isNull);
      expect(session.state.lastSuccessfulCheck, isNull);
    });

    test('join becomes ready on a valid scoped manifest', () async {
      final GuestSession session = GuestSession(source: source, clock: clock);
      await session.join(joinFor());
      expect(session.state.status, GuestSessionStatus.loading);
      expect(source.lastPartyId, 'party-1');
      expect(source.lastChannelId, 'cctv');

      source.controllers.single.add(makeManifest());
      await pumpEvents();

      expect(session.state.status, GuestSessionStatus.ready);
      expect(session.manifest?.version, 1);
      expect(session.state.lastSuccessfulCheck, clock.current);
      await session.dispose();
    });

    test('rejects an out-of-scope manifest as invalid-data', () async {
      final GuestSession session = GuestSession(source: source, clock: clock);
      await session.join(joinFor());
      source.controllers.single.add(
        makeManifest(partyId: 'other-party', channelId: 'cctv'),
      );
      await pumpEvents();

      expect(session.state.status, GuestSessionStatus.invalidData);
      expect(session.manifest, isNull);
      await session.dispose();
    });

    test('cold offline start has no fabricated manifest', () async {
      final GuestSession session = GuestSession(source: source, clock: clock);
      await session.join(joinFor());
      source.controllers.single.addError(Exception('network unreachable'));
      await pumpEvents();

      expect(session.state.status, GuestSessionStatus.unavailable);
      expect(session.manifest, isNull);
      await session.dispose();
    });

    test('network loss keeps last-known data stale, resume recovers', () async {
      final GuestSession session = GuestSession(source: source, clock: clock);
      await session.join(joinFor());
      source.controllers.single.add(makeManifest(version: 3));
      await pumpEvents();
      expect(session.state.status, GuestSessionStatus.ready);

      // Transient failure with retained metadata -> stale.
      source.controllers.single.addError(Exception('socket closed'));
      await pumpEvents();
      expect(session.state.status, GuestSessionStatus.stale);
      expect(session.manifest?.version, 3);

      // Background suspend keeps stale metadata; resume performs fresh read.
      await session.suspend();
      expect(session.state.status, GuestSessionStatus.stale);
      expect(session.manifest?.version, 3);

      await session.resume();
      expect(session.state.status, GuestSessionStatus.loading);
      // Retained manifest stays visible during the fresh read.
      expect(session.manifest?.version, 3);
      source.controllers.last.add(makeManifest(version: 4));
      await pumpEvents();
      expect(session.state.status, GuestSessionStatus.ready);
      expect(session.manifest?.version, 4);
      await session.dispose();
    });

    test(
      'suspend during loading retains the join binding for resume',
      () async {
        final GuestSession session = GuestSession(source: source, clock: clock);
        await session.join(joinFor());
        expect(session.state.status, GuestSessionStatus.loading);
        final int callsAfterJoin = source.watchCalls;

        // Backgrounding a cold start must not reset to idle: the typed
        // identifiers are retained in a suspended-loading state.
        await session.suspend();
        expect(session.state.status, GuestSessionStatus.loading);
        expect(session.joinData, joinFor());
        expect(session.manifest, isNull);

        // Foreground return re-subscribes with the retained binding.
        await session.resume();
        expect(session.state.status, GuestSessionStatus.loading);
        expect(source.watchCalls, callsAfterJoin + 1);
        source.controllers.last.add(makeManifest());
        await pumpEvents();
        expect(session.state.status, GuestSessionStatus.ready);
        expect(session.manifest?.version, 1);
        await session.dispose();
      },
    );

    test('unchanged version still updates the observation timestamp', () async {
      final GuestSession session = GuestSession(source: source, clock: clock);
      await session.join(joinFor());
      source.controllers.single.add(makeManifest(version: 2));
      await pumpEvents();
      expect(session.state.lastSuccessfulCheck, DateTime.utc(2026, 10, 29, 12));

      clock.current = DateTime.utc(2026, 10, 29, 13);
      source.controllers.single.add(makeManifest(version: 2));
      await pumpEvents();

      expect(session.state.status, GuestSessionStatus.ready);
      expect(session.manifest?.version, 2);
      expect(session.state.lastSuccessfulCheck, DateTime.utc(2026, 10, 29, 13));
      await session.dispose();
    });

    test('FORBIDDEN clears inaccessible data as denied', () async {
      final GuestSession session = GuestSession(source: source, clock: clock);
      await session.join(joinFor());
      source.controllers.single.add(makeManifest());
      await pumpEvents();
      expect(session.state.status, GuestSessionStatus.ready);

      source.controllers.single.addError(
        contractError(
          'permission-denied',
          'FORBIDDEN',
          'unregistered party/device secret-party-9',
        ),
      );
      await pumpEvents();

      expect(session.state.status, GuestSessionStatus.denied);
      expect(session.manifest, isNull);
      // Binding is retained so the UI can explain the rejection.
      expect(session.joinData?.partyId.value, 'party-1');
      // Fixed UI text only: the raw backend detail stays in logs.
      expect(session.state.message, 'Access was denied.');
      expect(session.state.message, isNot(contains('secret-party-9')));
      await session.dispose();
    });

    test(
      'UNAUTHENTICATED maps to denied with the provisioning message',
      () async {
        final GuestSession session = GuestSession(source: source, clock: clock);
        await session.join(joinFor());
        source.controllers.single.addError(
          contractError(
            'unauthenticated',
            'UNAUTHENTICATED',
            'missing party/device secret-party-9',
          ),
        );
        await pumpEvents();

        expect(session.state.status, GuestSessionStatus.denied);
        expect(session.manifest, isNull);
        // There is no login: denial means the device is not provisioned.
        expect(
          session.state.message,
          'This device is not provisioned for this party.',
        );
        expect(session.state.message, isNot(contains('secret-party-9')));
        await session.dispose();
      },
    );

    test('MANIFEST_MISMATCH surfaces invalid-data, never current', () async {
      final GuestSession session = GuestSession(source: source, clock: clock);
      await session.join(joinFor());
      source.controllers.single.addError(
        contractError(
          'internal',
          'MANIFEST_MISMATCH',
          'sibling manifest for secret-party-9',
        ),
      );
      await pumpEvents();

      expect(session.state.status, GuestSessionStatus.invalidData);
      expect(session.manifest, isNull);
      expect(session.state.isReady, isFalse);
      expect(session.state.message, 'The manifest data was invalid.');
      expect(session.state.message, isNot(contains('secret-party-9')));
      await session.dispose();
    });

    test('NOT_FOUND surfaces the no-manifest state', () async {
      final GuestSession session = GuestSession(source: source, clock: clock);
      await session.join(joinFor());
      source.controllers.single.addError(
        contractError(
          'internal',
          'NOT_FOUND',
          'no manifest for secret-party-9',
        ),
      );
      await pumpEvents();

      expect(session.state.status, GuestSessionStatus.unavailable);
      expect(session.manifest, isNull);
      expect(session.state.message, 'No manifest is published yet.');
      expect(session.state.message, isNot(contains('secret-party-9')));
      await session.dispose();
    });

    test('CLIP_EXPIRED is never labeled current', () async {
      final GuestSession session = GuestSession(source: source, clock: clock);
      await session.join(joinFor());
      source.controllers.single.add(makeManifest());
      await pumpEvents();
      expect(session.state.status, GuestSessionStatus.ready);

      source.controllers.single.addError(
        contractError(
          'internal',
          'CLIP_EXPIRED',
          'clip expired for secret-party-9',
        ),
      );
      await pumpEvents();

      expect(session.state.status, GuestSessionStatus.expired);
      expect(session.manifest, isNull);
      expect(session.state.isReady, isFalse);
      expect(session.state.message, 'This lineup has expired.');
      expect(session.state.message, isNot(contains('secret-party-9')));
      await session.dispose();
    });

    test('SDK-code-only failures classify without contract details', () async {
      final GuestSession session = GuestSession(source: source, clock: clock);
      await session.join(joinFor());
      source.controllers.single.addError(
        FirebaseFunctionsException(
          code: 'permission-denied',
          message: 'secret-party-9 is not registered',
        ),
      );
      await pumpEvents();

      expect(session.state.status, GuestSessionStatus.denied);
      expect(session.manifest, isNull);
      expect(session.state.message, isNot(contains('secret-party-9')));
      await session.dispose();
    });

    test(
      'transport failures stay sanitized on the cold and stale paths',
      () async {
        final GuestSession session = GuestSession(source: source, clock: clock);
        await session.join(joinFor());
        source.controllers.single.addError(
          StateError('socket reset by peer 10.0.0.9'),
        );
        await pumpEvents();

        expect(session.state.status, GuestSessionStatus.unavailable);
        expect(session.state.message, 'Could not reach the backend.');
        expect(session.state.message, isNot(contains('10.0.0.9')));
        await session.dispose();
      },
    );

    test(
      'leave clears identity and metadata and cancels subscription',
      () async {
        final GuestSession session = GuestSession(source: source, clock: clock);
        await session.join(joinFor());
        source.controllers.single.add(makeManifest());
        await pumpEvents();
        expect(session.state.status, GuestSessionStatus.ready);

        await session.leave();
        expect(session.state.status, GuestSessionStatus.idle);
        expect(session.joinData, isNull);
        expect(session.manifest, isNull);
        expect(session.state.lastSuccessfulCheck, isNull);
        expect(source.controllers.single.hasListener, isFalse);

        // Late events after leave must not resurrect the session.
        source.controllers.single.add(makeManifest(version: 9));
        await pumpEvents();
        expect(session.state.status, GuestSessionStatus.idle);
        expect(session.manifest, isNull);
        await session.dispose();
      },
    );

    test('party-switch race ignores the superseded session', () async {
      final GuestSession session = GuestSession(source: source, clock: clock);
      await session.join(joinFor(party: 'party-a'));
      final StreamController<PlaybackManifest> first =
          source.controllers.single;

      // Switch party before the first source responds.
      await session.join(joinFor(party: 'party-b'));
      expect(session.state.join?.partyId.value, 'party-b');
      expect(session.manifest, isNull);

      // Late response from the superseded session is ignored.
      first.add(makeManifest(partyId: 'party-a'));
      await pumpEvents();
      expect(session.state.status, GuestSessionStatus.loading);
      expect(session.manifest, isNull);

      source.controllers.last.add(makeManifest(partyId: 'party-b'));
      await pumpEvents();
      expect(session.state.status, GuestSessionStatus.ready);
      expect(session.manifest?.partyId, 'party-b');
      await session.dispose();
    });

    test('concurrent refreshes never overlap', () async {
      final GuestSession session = GuestSession(source: source, clock: clock);
      await session.join(joinFor());
      source.controllers.single.add(makeManifest());
      await pumpEvents();
      final int callsAfterJoin = source.watchCalls;

      final Future<void> first = session.refresh();
      final Future<void> second = session.refresh();
      await Future.wait(<Future<void>>[first, second]);
      expect(source.watchCalls, callsAfterJoin + 1);

      source.controllers.last.add(makeManifest(version: 5));
      await pumpEvents();
      expect(session.state.status, GuestSessionStatus.ready);
      expect(session.manifest?.version, 5);
      await session.dispose();
    });

    test('malformed payloads surface invalid-data with no manifest', () async {
      final GuestSession session = GuestSession(source: source, clock: clock);
      await session.join(joinFor());
      source.controllers.single.addError(
        const FormatException('bad manifest envelope'),
      );
      await pumpEvents();

      expect(session.state.status, GuestSessionStatus.invalidData);
      expect(session.manifest, isNull);
      await session.dispose();
    });
  });
}
