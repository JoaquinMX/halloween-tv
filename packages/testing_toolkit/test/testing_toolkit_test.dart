import 'package:channel_api/channel_api.dart';
import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:testing_toolkit/testing_toolkit.dart';

void main() {
  group('manifestFixture', () {
    test('is a valid 4-clip cctv manifest with unique cameras', () {
      final m = manifestFixture();
      expect(m.clips, hasLength(4));
      expect(m.clips.map((c) => c.cameraId).toSet(), kCctvCameraIds);
      expect(m.clips.map((c) => c.id).toSet(), hasLength(4));
      expect(m.clips.every((c) => isValidSha256Hex(c.sha256)), isTrue);
      expect(validateCctvManifest(m).isOk, isTrue);
    });

    test('survives a json round-trip unchanged', () {
      final m = manifestFixture(version: 7);
      final parsed = parseManifest(m.toJson());
      expect(parsed, equals(m));
      expect(validateCctvManifest(parsed).isOk, isTrue);
    });

    test('distinct equal fixtures share equality and hashCode', () {
      final a = manifestFixture();
      final b = manifestFixture();
      expect(a, equals(b));
      expect(a.hashCode, b.hashCode);
    });

    test('honours overrides', () {
      final published = DateTime.utc(2027, 1, 1);
      final m = manifestFixture(
        partyId: 'party-42',
        channelId: 'cctv',
        version: 9,
        publishedAt: published,
        overlay: const OverlaySettings(vignette: 0.8),
      );
      expect(m.partyId, 'party-42');
      expect(m.version, 9);
      expect(m.publishedAt, published);
      expect(m.overlay.vignette, 0.8);
    });
  });

  group('FakeCacheStore', () {
    test('miss, commit, then verified hit', () async {
      final store = FakeCacheStore();
      final first = manifestFixture().clips.first;
      expect(await store.findVerified(first), isNull);

      final committed = await store.commit(
        DownloadedMedia(
          clipId: first.id,
          bytes: [1, 2, 3],
          sha256: first.sha256,
        ),
      );
      expect(committed.clipId, first.id);
      expect(committed.sha256, first.sha256);

      final hit = await store.findVerified(first);
      expect(hit, isNotNull);
      expect(hit, same(committed));
      expect(store.size, 1);
      expect(store.entryFor(first.id), same(committed));
    });

    test('sha mismatch surfaces as a miss', () async {
      final store = FakeCacheStore();
      final clip = manifestFixture().clips.first;
      store.seed(
        CachedMedia(
          clipId: clip.id,
          localRef: 'mem://stale',
          sha256: clip.sha256.replaceRange(0, 1, '0'),
        ),
      );
      expect(await store.findVerified(clip), isNull);
    });

    test('deleteExpired clears and reports removed count', () async {
      final store = FakeCacheStore();
      final clips = manifestFixture().clips;
      for (final c in clips.take(2)) {
        await store.commit(
          DownloadedMedia(clipId: c.id, bytes: [0], sha256: c.sha256),
        );
      }
      expect(store.size, 2);
      expect(await store.deleteExpired(), 2);
      expect(store.size, 0);
      expect(await store.findVerified(clips.first), isNull);
      expect(await store.deleteExpired(), 0);
    });
  });

  group('FakeClock', () {
    test('starts at a fixed instant and advances deterministically', () {
      final clock = FakeClock(DateTime.utc(2026, 10, 31));
      final t0 = clock.now();
      expect(t0, DateTime.utc(2026, 10, 31));
      clock.advance(const Duration(minutes: 5));
      expect(clock.now().difference(t0), const Duration(minutes: 5));
      final target = DateTime.utc(2027, 1, 1);
      clock.setTo(target);
      expect(clock.now(), target);
    });

    test('defaults to Halloween 2026 20:00 UTC', () {
      expect(FakeClock().now(), DateTime.utc(2026, 10, 31, 20));
    });
  });

  group('FakePlaybackHandle', () {
    test('records prepare/activate in order', () async {
      final h = FakePlaybackHandle();
      expect(h.prepared, isFalse);
      expect(h.activated, isFalse);
      await h.prepare();
      expect(h.prepared, isTrue);
      expect(h.activated, isFalse);
      await h.activate();
      expect(h.activated, isTrue);
      expect(h.events, ['prepare', 'activate']);
    });
  });

  group('FakeChannelPlugin', () {
    test('exposes descriptor and returns its build widget', () {
      const descriptor = ChannelDescriptor(
        id: 'cctv',
        title: 'CCTV',
        version: 1,
        capabilities: ChannelCapability(videoPlayback: true),
      );
      const marker = Text('cctv-marker', textDirection: TextDirection.ltr);
      final plugin = FakeChannelPlugin(descriptor, marker);
      expect(plugin.descriptor, descriptor);
      final ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: FakePlaybackHandle(),
      );
      expect(plugin.build(ctx), same(marker));
    });

    testWidgets('widget is rendered by the test tree', (tester) async {
      final plugin = FakeChannelPlugin(
        const ChannelDescriptor(id: 'retro', title: 'Retro', version: 1),
        const Text('retro-tv', textDirection: TextDirection.ltr),
      );
      await tester.pumpWidget(
        plugin.build(
          ChannelContext(
            partyId: PartyId('party-1'),
            playbackHandle: FakePlaybackHandle(),
          ),
        ),
      );
      expect(find.text('retro-tv'), findsOneWidget);
    });
  });
}
