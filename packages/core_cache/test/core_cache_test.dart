import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';

const String _shaA =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const String _shaB =
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/// Local in-memory CacheStore (core_cache must not depend on testing_toolkit).
///
/// Mirrors the port contract: `findVerified` only returns an entry when the
/// stored digest matches the descriptor being requested.
final class _MemStore implements CacheStore {
  final Map<String, CachedMedia> entries = {};

  @override
  Future<CachedMedia?> findVerified(ClipDescriptor clip) async {
    final e = entries[clip.id];
    if (e != null && e.sha256 == clip.sha256) {
      return e;
    }
    return null;
  }

  @override
  Future<CachedMedia> commit(DownloadedMedia media) async {
    final e = CachedMedia(
      clipId: media.clipId,
      localRef: 'mem://${media.clipId}',
      sha256: media.sha256,
    );
    entries[media.clipId] = e;
    return e;
  }

  @override
  Future<int> deleteExpired() async {
    final n = entries.length;
    entries.clear();
    return n;
  }
}

ClipDescriptor clip(String id, String sha) => ClipDescriptor(
  id: id,
  cameraId: 'CAM-01',
  storageObjectId: 'obj-$id',
  sha256: sha,
  sizeBytes: 128,
  duration: const Duration(seconds: 5),
  mimeType: 'video/mp4',
);

void main() {
  test('commit then findVerified hits on matching sha', () async {
    final store = _MemStore();
    final committed = await store.commit(
      DownloadedMedia(clipId: 'c1', bytes: [1, 2, 3], sha256: _shaA),
    );
    expect(committed.clipId, 'c1');
    expect(committed.localRef, isNotEmpty);
    expect(committed.sha256, _shaA);

    final hit = await store.findVerified(clip('c1', _shaA));
    expect(hit, isNotNull);
    expect(hit, same(committed));
    expect(store.entries, hasLength(1));
  });

  test('findVerified misses on unknown clip or sha mismatch', () async {
    final store = _MemStore();
    await store.commit(
      DownloadedMedia(clipId: 'c1', bytes: [9], sha256: _shaA),
    );
    expect(await store.findVerified(clip('nope', _shaA)), isNull);
    expect(await store.findVerified(clip('c1', _shaB)), isNull);
  });

  test('re-commit replaces entry so stale digest no longer resolves', () async {
    final store = _MemStore();
    await store.commit(
      DownloadedMedia(clipId: 'c1', bytes: [1], sha256: _shaA),
    );
    await store.commit(
      DownloadedMedia(clipId: 'c1', bytes: [2], sha256: _shaB),
    );
    expect(await store.findVerified(clip('c1', _shaA)), isNull);
    expect((await store.findVerified(clip('c1', _shaB)))!.sha256, _shaB);
  });

  test('deleteExpired clears entries and reports count', () async {
    final store = _MemStore();
    await store.commit(
      DownloadedMedia(clipId: 'c1', bytes: [1], sha256: _shaA),
    );
    await store.commit(
      DownloadedMedia(clipId: 'c2', bytes: [2], sha256: _shaB),
    );
    expect(await store.deleteExpired(), 2);
    expect(await store.findVerified(clip('c1', _shaA)), isNull);
    expect(await store.deleteExpired(), 0);
  });

  test('DownloadedMedia freezes bytes and exposes byteLength', () {
    final m = DownloadedMedia(clipId: 'c', bytes: [1, 2], sha256: _shaA);
    expect(m.byteLength, 2);
    expect(() => m.bytes.add(3), throwsUnsupportedError);
  });

  test('DownloadedMedia rejects empty clipId and malformed sha256', () {
    expect(
      () => DownloadedMedia(clipId: ' ', bytes: [1], sha256: _shaA),
      throwsArgumentError,
    );
    expect(
      () => DownloadedMedia(clipId: 'c', bytes: [1], sha256: 'not-a-hash'),
      throwsArgumentError,
    );
    expect(
      () =>
          DownloadedMedia(clipId: 'c', bytes: [1], sha256: _shaA.substring(1)),
      throwsArgumentError,
    );
  });

  test('CachedMedia compares by value', () {
    const a = CachedMedia(clipId: 'c', localRef: 'file://a', sha256: _shaA);
    const b = CachedMedia(clipId: 'c', localRef: 'file://a', sha256: _shaA);
    const c = CachedMedia(clipId: 'c', localRef: 'file://b', sha256: _shaA);
    expect(a, equals(b));
    expect(a.hashCode, b.hashCode);
    expect(a, isNot(equals(c)));
  });

  test('store implements the CacheStore port', () {
    final CacheStore store = _MemStore();
    expect(store, isA<CacheStore>());
  });

  group('sha256Hex', () {
    test('matches FIPS vectors (empty, abc)', () {
      expect(
        sha256Hex(<int>[]),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
      expect(
        sha256Hex('abc'.codeUnits),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    });

    test('matches 0x01,0x02,0x03 against the platform digest', () {
      expect(
        sha256Hex(<int>[1, 2, 3]),
        '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
      );
    });
  });

  group('DownloadedMedia.fromBytes', () {
    test('computes its own digest (cannot carry a mismatched sha)', () {
      final media = DownloadedMedia.fromBytes(
        clipId: 'c1',
        bytes: [1, 2, 3],
      );
      expect(
        media.sha256,
        '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
      );
      expect(media.byteLength, 3);
      expect(() => media.bytes.add(4), throwsUnsupportedError);
    });

    test('matchesClip accepts exact bytes, rejects tampered bytes', () {
      final bytes = <int>[10, 20, 30, 40];
      final media = DownloadedMedia.fromBytes(clipId: 'c1', bytes: bytes);
      final good = ClipDescriptor(
        id: 'c1',
        cameraId: 'CAM-01',
        storageObjectId: 'assets/cam01.mp4',
        sha256: media.sha256,
        sizeBytes: bytes.length,
        duration: const Duration(seconds: 2),
        mimeType: 'video/mp4',
      );
      expect(media.matchesClip(good), isTrue);

      final tampered = List<int>.of(bytes)..[0] ^= 0xff;
      final tamperedMedia = DownloadedMedia.fromBytes(
        clipId: 'c1',
        bytes: tampered,
      );
      // Same length, but the self-computed digest no longer matches the
      // manifest descriptor: the tamper is detected, not carried through.
      expect(tamperedMedia.matchesClip(good), isFalse);

      final wrongSize = ClipDescriptor(
        id: 'c1',
        cameraId: 'CAM-01',
        storageObjectId: 'assets/cam01.mp4',
        sha256: media.sha256,
        sizeBytes: bytes.length + 1,
        duration: const Duration(seconds: 2),
        mimeType: 'video/mp4',
      );
      expect(media.matchesClip(wrongSize), isFalse);
    });

    test('committed fromBytes entry resolves through the port', () async {
      final store = _MemStore();
      final media = DownloadedMedia.fromBytes(
        clipId: 'c9',
        bytes: [7, 7, 7],
      );
      final entry = await store.commit(media);
      expect(entry.sha256, media.sha256);
      final descriptor = ClipDescriptor(
        id: 'c9',
        cameraId: 'CAM-01',
        storageObjectId: 'obj-c9',
        sha256: media.sha256,
        sizeBytes: 3,
        duration: const Duration(seconds: 5),
        mimeType: 'video/mp4',
      );
      expect(await store.findVerified(descriptor), same(entry));
    });
  });
}
