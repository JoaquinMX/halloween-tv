/// Boot sequence tests: registry -> channel -> manifest (no UI).
library;

import 'package:channel_cctv/channel_cctv.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kernel_app/kernel_app.dart';
import 'package:testing_toolkit/testing_toolkit.dart';
import 'package:tv_app/src/wall/wall_boot.dart';

import 'support/fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('WallBoot', () {
    test('binds the haunted-surveillance channel from the kernel registry',
        () async {
      final InMemoryManifestStore store = InMemoryManifestStore();
      final WallBoot boot = WallBoot(store: store);

      final WallBootResult result = await boot.boot();

      expect(result.isReady, isTrue, reason: result.unavailableReason);
      final ChannelRegistry registry = result.registry!;
      expect(registry.allIds, contains(hauntedSurveillanceChannelId));
      // Retro stub is registered (visible to the kernel) but never resolved
      // or built, so the wall stays the CCTV wall.
      expect(registry.allIds, hasLength(2));

      final ChannelPlugin plugin = result.plugin!;
      expect(plugin.descriptor.id, hauntedSurveillanceChannelId);
      expect(plugin.descriptor.capabilities.videoPlayback, isTrue);
      expect(plugin.descriptor.capabilities.effects, isTrue);

      final PlaybackManifest manifest = result.manifest!;
      expect(result.usedCachedManifest, isFalse);
      expect(
        validateCctvManifest(manifest).isOk,
        isTrue,
        reason: 'boot must hand the wall a valid manifest',
      );
      expect(
        manifest.clips.map((ClipDescriptor c) => c.cameraId),
        <String>['CAM-01', 'CAM-02', 'CAM-03', 'CAM-04'],
      );
      // The fixture is persisted so the next cold start restores a wall.
      expect(store.writes, 1);
      expect(store.stored!.version, manifest.version);
    });

    test('restores the last cached manifest instead of the fixture', () async {
      final PlaybackManifest cached = manifestFixture(
        partyId: 'local-party',
        channelId: hauntedSurveillanceChannelId,
        version: 7,
      );
      final InMemoryManifestStore store = InMemoryManifestStore(cached);

      final WallBootResult result = await WallBoot(store: store).boot();

      expect(result.isReady, isTrue);
      expect(result.usedCachedManifest, isTrue);
      expect(result.manifest!.version, 7);
      expect(store.writes, 0, reason: 'a cached wall must not be rewritten');
    });

    test('a corrupt cached manifest falls back to the fixture', () async {
      // Three clips: parseable JSON but invalid for a 2x2 CCTV wall.
      final PlaybackManifest broken = manifestFixture(
        partyId: 'local-party',
        channelId: hauntedSurveillanceChannelId,
      );
      final PlaybackManifest threeClips = PlaybackManifest(
        partyId: broken.partyId,
        channelId: broken.channelId,
        version: 2,
        clips: broken.clips.take(3).toList(),
        publishedAt: broken.publishedAt,
      );
      final InMemoryManifestStore store = InMemoryManifestStore(threeClips);

      final WallBootResult result = await WallBoot(store: store).boot();

      expect(result.isReady, isTrue);
      expect(result.usedCachedManifest, isFalse);
      expect(result.manifest!.clips, hasLength(4));
      expect(store.writes, 1, reason: 'the repaired wall is re-cached');
    });

    test('reports no wall when the channel is not registered', () async {
      final WallBoot boot = WallBoot(
        store: InMemoryManifestStore(),
        registryFactory: _retroOnlyRegistry,
      );

      final WallBootResult result = await boot.boot();

      expect(result.isReady, isFalse);
      expect(result.unavailableReason, contains('NO WALL'));
      expect(result.unavailableReason, contains(hauntedSurveillanceChannelId));
      expect(result.manifest, isNull);
    });

    test('reports no wall when even the fixture violates the CCTV contract',
        () async {
      final WallBoot boot = WallBoot(
        store: InMemoryManifestStore(),
        fixture: ({required String partyId, required String channelId}) =>
            PlaybackManifest(
          partyId: partyId,
          channelId: channelId,
          version: 1,
          clips: const <ClipDescriptor>[],
          publishedAt: DateTime.utc(2026, 10, 31),
        ),
      );

      final WallBootResult result = await boot.boot();

      expect(result.isReady, isFalse);
      expect(result.unavailableReason, contains('WALL UNAVAILABLE'));
    });

    test('survives a broken manifest store', () async {
      final InMemoryManifestStore store = InMemoryManifestStore()
        ..failReads = true;

      final WallBootResult result = await WallBoot(store: store).boot();

      expect(result.isReady, isTrue);
      expect(result.usedCachedManifest, isFalse);
    });

    test('readCached ignores invalid cached manifests', () async {
      final PlaybackManifest broken = manifestFixture(
        channelId: hauntedSurveillanceChannelId,
      );
      final InMemoryManifestStore store = InMemoryManifestStore(
        PlaybackManifest(
          partyId: broken.partyId,
          channelId: broken.channelId,
          version: 1,
          clips: broken.clips.take(2).toList(),
          publishedAt: broken.publishedAt,
        ),
      );
      final WallBoot boot = WallBoot(store: store);

      expect(await boot.readCached(), isNull);

      store.stored = manifestFixture(
        channelId: hauntedSurveillanceChannelId,
        version: 4,
      );
      expect((await boot.readCached())!.version, 4);
    });
  });
}

ChannelRegistry _retroOnlyRegistry() {
  final ChannelRegistry registry = ChannelRegistry();
  // Only the inactive retro stub: resolving the CCTV channel must fail.
  registry.register(_ChannelPluginStub());
  return registry;
}

/// Minimal plugin used to build a registry without the CCTV channel.
final class _ChannelPluginStub implements ChannelPlugin {
  @override
  ChannelDescriptor get descriptor => const ChannelDescriptor(
        id: 'retro_horror_test',
        title: 'Retro',
        version: 1,
      );

  @override
  Widget build(ChannelContext context) => const SizedBox.shrink();
}
