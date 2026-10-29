/// Boot sequence tests: registry -> channel -> manifest (no UI).
///
/// All hash assertions run through the real prod paths: manifests carry
/// `sha256Hex(realBytes)` digests computed by `core_cache`, and every boot
/// goes through the real `WallBoot.boot()` including byte verification.
library;

import 'dart:convert';
import 'dart:io';

import 'package:channel_cctv/channel_cctv.dart';
import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kernel_app/kernel_app.dart';
import 'package:tv_app/src/wall/wall_boot.dart';

import 'support/fakes.dart';

const List<String> _cameras = <String>['CAM-01', 'CAM-02', 'CAM-03', 'CAM-04'];

/// Deterministic stand-in for bundled clip bytes (per-camera, distinct).
List<int> _bytesFor(String cameraId) =>
    utf8.encode('halloween-tv-offline-bytes@$cameraId#' * 8);

/// Real manifest whose digests match [bytesByAsset] byte-for-byte.
PlaybackManifest _manifestFor(
  Map<String, List<int>> bytesByAsset, {
  String partyId = 'local-party',
  String channelId = hauntedSurveillanceChannelId,
  int version = 1,
}) {
  return PlaybackManifest(
    partyId: partyId,
    channelId: channelId,
    version: version,
    clips: <ClipDescriptor>[
      for (var i = 0; i < _cameras.length; i++)
        ClipDescriptor(
          id: _cameras[i],
          cameraId: _cameras[i],
          storageObjectId: 'assets/cam0${i + 1}.mp4',
          sha256: sha256Hex(bytesByAsset['assets/cam0${i + 1}.mp4']!),
          sizeBytes: bytesByAsset['assets/cam0${i + 1}.mp4']!.length,
          duration: const Duration(seconds: 2),
          mimeType: 'video/mp4',
        ),
    ],
    publishedAt: DateTime.utc(2026, 10, 31, 20),
  );
}

Map<String, List<int>> _realBytes() => <String, List<int>>{
  'assets/cam01.mp4': _bytesFor('CAM-01'),
  'assets/cam02.mp4': _bytesFor('CAM-02'),
  'assets/cam03.mp4': _bytesFor('CAM-03'),
  'assets/cam04.mp4': _bytesFor('CAM-04'),
};

WallAssetBytesLoader _bytesLoader(Map<String, List<int>> bytesByAsset) =>
    (String path) async {
      final bytes = bytesByAsset[path];
      if (bytes == null) {
        throw StateError('no bundled bytes for $path');
      }
      return bytes;
    };

WallBoot _bootWith({
  required Map<String, List<int>> bytesByAsset,
  required PlaybackManifest fixtureManifest,
  InMemoryManifestStore? store,
  String partyId = 'local-party',
  WallBundleLoader? bundleLoader,
}) {
  return WallBoot(
    store: store ?? InMemoryManifestStore(),
    partyId: partyId,
    fixtureLoader: ({required String partyId, required String channelId}) async =>
        fixtureManifest,
    assetBytesLoader: _bytesLoader(bytesByAsset),
    bundleLoader: bundleLoader ?? ((String key) async => throw StateError('no bundle in unit tests')),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('WallBoot', () {
    test('boots from the bundled fixture when bytes verify', () async {
      final bytesByAsset = _realBytes();
      final fixture = _manifestFor(bytesByAsset);
      final store = InMemoryManifestStore();
      final boot = _bootWith(
        bytesByAsset: bytesByAsset,
        fixtureManifest: fixture,
        store: store,
      );

      final result = await boot.boot();

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

    test('parses the gen_fixtures.sh offline shape end to end', () async {
      final bytesByAsset = _realBytes();
      final shape = <String, Object?>{
        'clips': <Object?>[
          for (var i = 0; i < _cameras.length; i++)
            <String, Object?>{
              'cameraId': _cameras[i],
              'sha256': sha256Hex(bytesByAsset['assets/cam0${i + 1}.mp4']!),
              'sizeBytes': bytesByAsset['assets/cam0${i + 1}.mp4']!.length,
              'durationMs': 2000,
              'asset': 'assets/cam0${i + 1}.mp4',
            },
        ],
      };
      final parsed = parseFixtureManifestJson(
        shape,
        partyId: 'local-party',
        channelId: hauntedSurveillanceChannelId,
      );
      expect(validateCctvManifest(parsed).isOk, isTrue);
      expect(
        parsed.clips.map((c) => c.id),
        <String>['clip-01', 'clip-02', 'clip-03', 'clip-04'],
      );

      final store = InMemoryManifestStore();
      final boot = _bootWith(
        bytesByAsset: bytesByAsset,
        fixtureManifest: parsed,
        store: store,
      );
      final result = await boot.boot();
      expect(result.isReady, isTrue, reason: result.unavailableReason);
      expect(result.manifest!.clips.map((c) => c.cameraId),
          <String>['CAM-01', 'CAM-02', 'CAM-03', 'CAM-04']);
    });

    test('restores the last cached manifest instead of the fixture', () async {
      final bytesByAsset = _realBytes();
      final cached = _manifestFor(bytesByAsset, version: 7);
      final fixture = _manifestFor(bytesByAsset, version: 1);
      final store = InMemoryManifestStore(cached);

      final result = await _bootWith(
        bytesByAsset: bytesByAsset,
        fixtureManifest: fixture,
        store: store,
      ).boot();

      expect(result.isReady, isTrue);
      expect(result.usedCachedManifest, isTrue);
      expect(result.manifest!.version, 7);
      expect(store.writes, 0, reason: 'a cached wall must not be rewritten');
    });

    test('rejects a cached manifest for another party', () async {
      final bytesByAsset = _realBytes();
      final cached = _manifestFor(bytesByAsset,
          partyId: 'someone-elses-party', version: 7);
      final fixture = _manifestFor(bytesByAsset, version: 3);
      final store = InMemoryManifestStore(cached);

      final result = await _bootWith(
        bytesByAsset: bytesByAsset,
        fixtureManifest: fixture,
        store: store,
      ).boot();

      expect(result.isReady, isTrue, reason: result.unavailableReason);
      expect(result.usedCachedManifest, isFalse);
      expect(result.manifest!.version, 3);
      expect(result.manifest!.partyId, 'local-party');
    });

    test('rejects a cached manifest for another channel', () async {
      final bytesByAsset = _realBytes();
      final cached = _manifestFor(bytesByAsset,
          channelId: 'retro_horror_test', version: 7);
      final fixture = _manifestFor(bytesByAsset, version: 3);
      final store = InMemoryManifestStore(cached);

      final result = await _bootWith(
        bytesByAsset: bytesByAsset,
        fixtureManifest: fixture,
        store: store,
      ).boot();

      expect(result.isReady, isTrue, reason: result.unavailableReason);
      expect(result.usedCachedManifest, isFalse);
      expect(result.manifest!.channelId, hauntedSurveillanceChannelId);
    });

    test('fails closed on a tampered bundled sha256', () async {
      final bytesByAsset = _realBytes();
      final good = _manifestFor(bytesByAsset);
      final tamperedCam02 = List<int>.of(bytesByAsset['assets/cam02.mp4']!);
      tamperedCam02[0] ^= 0xff;
      final tamperedBytes = Map<String, List<int>>.of(bytesByAsset)
        ..['assets/cam02.mp4'] = tamperedCam02;
      final store = InMemoryManifestStore();

      final result = await _bootWith(
        bytesByAsset: tamperedBytes,
        fixtureManifest: good,
        store: store,
      ).boot();

      expect(result.isReady, isFalse);
      expect(result.unavailableReason, contains('hash mismatch'));
      expect(result.manifest, isNull);
      expect(store.writes, 0, reason: 'tampered bytes must not be cached');
    });

    test('fails closed on a tampered bundled size', () async {
      final bytesByAsset = _realBytes();
      final good = _manifestFor(bytesByAsset);
      final wrongSize = PlaybackManifest(
        partyId: good.partyId,
        channelId: good.channelId,
        version: good.version,
        clips: <ClipDescriptor>[
          for (final c in good.clips)
            c.cameraId == 'CAM-03'
                ? ClipDescriptor(
                    id: c.id,
                    cameraId: c.cameraId,
                    storageObjectId: c.storageObjectId,
                    sha256: c.sha256,
                    sizeBytes: c.sizeBytes + 1,
                    duration: c.duration,
                    mimeType: c.mimeType,
                  )
                : c,
        ],
        publishedAt: good.publishedAt,
      );
      final store = InMemoryManifestStore();

      final result = await _bootWith(
        bytesByAsset: bytesByAsset,
        fixtureManifest: wrongSize,
        store: store,
      ).boot();

      expect(result.isReady, isFalse);
      expect(result.unavailableReason, contains('hash mismatch'));
      expect(store.writes, 0);
    });

    test('fails closed when the cached bytes no longer verify', () async {
      final bytesByAsset = _realBytes();
      final cached = _manifestFor(bytesByAsset, version: 7);
      // Cached manifest was valid when written, but the bundled bytes changed
      // (or were corrupted): the wall must fall back, not play stale hashes.
      final rotated = Map<String, List<int>>.of(bytesByAsset)
        ..['assets/cam01.mp4'] = utf8.encode('rotated-clip-bytes' * 16);
      final store = InMemoryManifestStore(cached);

      final result = await _bootWith(
        bytesByAsset: rotated,
        fixtureManifest: _manifestFor(rotated, version: 1),
        store: store,
      ).boot();

      expect(result.isReady, isTrue, reason: result.unavailableReason);
      expect(result.usedCachedManifest, isFalse);
      expect(result.manifest!.version, 1);
    });

    test('a corrupt cached manifest falls back to the fixture', () async {
      final bytesByAsset = _realBytes();
      final good = _manifestFor(bytesByAsset);
      final threeClips = PlaybackManifest(
        partyId: good.partyId,
        channelId: good.channelId,
        version: 2,
        clips: good.clips.take(3).toList(),
        publishedAt: good.publishedAt,
      );
      final store = InMemoryManifestStore(threeClips);

      final result = await _bootWith(
        bytesByAsset: bytesByAsset,
        fixtureManifest: good,
        store: store,
      ).boot();

      expect(result.isReady, isTrue);
      expect(result.usedCachedManifest, isFalse);
      expect(result.manifest!.clips, hasLength(4));
      expect(store.writes, 1, reason: 'the repaired wall is re-cached');
    });

    test('reports unavailable when the bundle file is missing', () async {
      final store = InMemoryManifestStore();
      final boot = WallBoot(
        store: store,
        assetBytesLoader: _bytesLoader(_realBytes()),
        bundleLoader: (String key) async =>
            throw StateError('bundle asset missing: $key'),
      );

      final result = await boot.boot();

      expect(result.isReady, isFalse);
      expect(result.unavailableReason, contains('WALL UNAVAILABLE'));
      expect(store.writes, 0);
    });

    test('reports no wall when the channel is not registered', () async {
      final bytesByAsset = _realBytes();
      final boot = WallBoot(
        store: InMemoryManifestStore(),
        registryFactory: _retroOnlyRegistry,
        fixtureLoader: ({required String partyId, required String channelId}) async =>
            _manifestFor(bytesByAsset),
        assetBytesLoader: _bytesLoader(bytesByAsset),
      );

      final result = await boot.boot();

      expect(result.isReady, isFalse);
      expect(result.unavailableReason, contains('NO WALL'));
      expect(result.unavailableReason, contains(hauntedSurveillanceChannelId));
      expect(result.manifest, isNull);
    });

    test('reports no wall when even the fixture violates the CCTV contract',
        () async {
      final boot = WallBoot(
        store: InMemoryManifestStore(),
        fixture: ({required String partyId, required String channelId}) =>
            PlaybackManifest(
          partyId: partyId,
          channelId: channelId,
          version: 1,
          clips: const <ClipDescriptor>[],
          publishedAt: DateTime.utc(2026, 10, 31),
        ),
        assetBytesLoader: _bytesLoader(_realBytes()),
      );

      final result = await boot.boot();

      expect(result.isReady, isFalse);
      expect(result.unavailableReason, contains('WALL UNAVAILABLE'));
    });

    test('survives a broken manifest store', () async {
      final bytesByAsset = _realBytes();
      final store = InMemoryManifestStore()..failReads = true;

      final result = await _bootWith(
        bytesByAsset: bytesByAsset,
        fixtureManifest: _manifestFor(bytesByAsset),
        store: store,
      ).boot();

      expect(result.isReady, isTrue);
      expect(result.usedCachedManifest, isFalse);
    });

    test('readCached ignores invalid cached manifests', () async {
      final bytesByAsset = _realBytes();
      final good = _manifestFor(bytesByAsset);
      final store = InMemoryManifestStore(
        PlaybackManifest(
          partyId: good.partyId,
          channelId: good.channelId,
          version: 1,
          clips: good.clips.take(2).toList(),
          publishedAt: good.publishedAt,
        ),
      );
      final boot = _bootWith(
        bytesByAsset: bytesByAsset,
        fixtureManifest: good,
        store: store,
      );

      expect(await boot.readCached(), isNull);

      store.stored = _manifestFor(bytesByAsset, version: 4);
      expect((await boot.readCached())!.version, 4);
    });

    test('readCached rejects other-party manifests', () async {
      final bytesByAsset = _realBytes();
      final store = InMemoryManifestStore(
        _manifestFor(bytesByAsset, partyId: 'intruder-party', version: 4),
      );
      final boot = _bootWith(
        bytesByAsset: bytesByAsset,
        fixtureManifest: _manifestFor(bytesByAsset),
        store: store,
      );

      expect(await boot.readCached(), isNull);
    });

    test('sha256Hex matches the real committed cam01 bytes', () async {
      final manifestFile = File('assets/fixture_manifest.json');
      expect(await manifestFile.exists(), isTrue,
          reason: 'run from the tv_app package directory');
      final manifestJson = jsonDecode(await manifestFile.readAsString())
          as Map<String, Object?>;
      final clips = (manifestJson['clips'] as List).cast<Map<String, Object?>>();
      final cam01 = clips.singleWhere(
        (c) => c['cameraId'] == 'CAM-01',
        orElse: () => throw StateError('CAM-01 missing from fixture_manifest.json'),
      );
      final expectedSize = cam01['sizeBytes'] as int;
      final expectedSha = cam01['sha256'] as String;
      final file = File('assets/cam01.mp4');
      expect(await file.exists(), isTrue,
          reason: 'run from the tv_app package directory');
      final bytes = await file.readAsBytes();
      expect(bytes.length, expectedSize,
          reason:
              'on-disk cam01 bytes must match the committed fixture_manifest.json');
      expect(
        sha256Hex(bytes),
        expectedSha,
        reason:
            'on-disk cam01 bytes must match the committed fixture_manifest.json',
      );
      // Negative control: the comparison above is not a tautology — tampered
      // bytes must disagree with the committed manifest entry.
      final tampered = List<int>.of(bytes);
      tampered[0] ^= 0xff;
      expect(sha256Hex(tampered), isNot(equals(expectedSha)),
          reason: 'tampered bytes must mismatch the manifest sha256');
      expect(tampered.length + 1, isNot(equals(expectedSize)),
          reason: 'a wrong size must mismatch the manifest sizeBytes');
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
