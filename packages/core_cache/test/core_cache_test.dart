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
}
