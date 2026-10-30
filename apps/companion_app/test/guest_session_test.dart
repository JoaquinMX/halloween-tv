// Guest session lifecycle tests: scoped-manifest joins, network
// loss/recovery, observation timestamps, denied/expired outcomes,
// cancellation, and party-switch races. Uses a minimal fake of the
// `ManifestSource` port bound to `PlaybackManifest`
// (never the concrete connection).

import 'dart:async';

import 'package:channel_api/channel_api.dart';
import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:companion_app/src/session/guest_session.dart';
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

/// Pumps async stream delivery.
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
        Exception('FORBIDDEN: unregistered party/device'),
      );
      await pumpEvents();

      expect(session.state.status, GuestSessionStatus.denied);
      expect(session.manifest, isNull);
      // Binding is retained so the UI can explain the rejection.
      expect(session.joinData?.partyId.value, 'party-1');
      await session.dispose();
    });

    test('UNAUTHENTICATED maps to denied', () async {
      final GuestSession session = GuestSession(source: source, clock: clock);
      await session.join(joinFor());
      source.controllers.single.addError(
        Exception('unauthenticated: missing party/device'),
      );
      await pumpEvents();

      expect(session.state.status, GuestSessionStatus.denied);
      expect(session.manifest, isNull);
      await session.dispose();
    });

    test('CLIP_EXPIRED is never labeled current', () async {
      final GuestSession session = GuestSession(source: source, clock: clock);
      await session.join(joinFor());
      source.controllers.single.add(makeManifest());
      await pumpEvents();
      expect(session.state.status, GuestSessionStatus.ready);

      source.controllers.single.addError(Exception('CLIP_EXPIRED'));
      await pumpEvents();

      expect(session.state.status, GuestSessionStatus.expired);
      expect(session.manifest, isNull);
      expect(session.state.isReady, isFalse);
      await session.dispose();
    });

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
