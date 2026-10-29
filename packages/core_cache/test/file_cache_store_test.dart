import 'dart:io';

import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';

PlaybackManifest _manifest({int version = 1}) => PlaybackManifest(
  partyId: 'party-file-test',
  channelId: 'cctv',
  version: version,
  publishedAt: DateTime.utc(2026, 10, 29),
  clips: <ClipDescriptor>[
    for (var i = 0; i < 4; i++) _clip(i, <int>[i + 1, i + 2, i + 3]),
  ],
);

ClipDescriptor _clip(int index, List<int> bytes) => ClipDescriptor(
  id: 'clip-$index',
  cameraId: 'CAM-0${index + 1}',
  storageObjectId: 'object-$index',
  sha256: sha256Hex(bytes),
  sizeBytes: bytes.length,
  duration: const Duration(seconds: 3),
  mimeType: 'video/mp4',
);

void main() {
  late Directory temp;

  setUp(() async {
    temp = await Directory.systemTemp.createTemp('core-cache-test-');
  });

  tearDown(() async {
    if (await temp.exists()) {
      await temp.delete(recursive: true);
    }
  });

  test('file cache commit and findVerified rehash real bytes', () async {
    final FileCacheStore store = FileCacheStore(temp);
    final List<int> bytes = <int>[1, 2, 3, 4];
    final ClipDescriptor clip = _clip(0, bytes);
    final CachedMedia entry = await store.commit(
      DownloadedMedia.fromBytes(clipId: clip.id, bytes: bytes),
    );

    expect(entry.sha256, clip.sha256);
    expect(entry.localRef.startsWith(temp.path), isTrue);
    expect(await File(entry.localRef).readAsBytes(), bytes);
    expect(await store.findVerified(clip), equals(entry));
    expect(
      await temp
          .list(recursive: true)
          .where((FileSystemEntity file) => file.path.endsWith('.part'))
          .toList(),
      isEmpty,
    );

    await File(entry.localRef).writeAsBytes(<int>[9, 9, 9, 9]);
    expect(await store.findVerified(clip), isNull);
  });

  test(
    'deleteExpired removes stale media and interrupted part files',
    () async {
      final DateTime now = DateTime.utc(2026, 10, 29, 12);
      final FileCacheStore store = FileCacheStore(
        temp,
        maxAge: const Duration(days: 1),
        now: () => now,
      );
      final CachedMedia entry = await store.commit(
        DownloadedMedia.fromBytes(clipId: 'old', bytes: <int>[1, 2, 3]),
      );
      final Directory mediaDir = Directory(
        '${temp.path}${Platform.pathSeparator}media',
      );
      final File abandoned = File(
        '${mediaDir.path}${Platform.pathSeparator}interrupted.part',
      );
      await abandoned.writeAsBytes(<int>[5, 6]);
      final DateTime stale = now.subtract(const Duration(days: 2));
      await File(entry.localRef).setLastModified(stale);
      await abandoned.setLastModified(stale);

      expect(await store.deleteExpired(), 2);
      expect(await File(entry.localRef).exists(), isFalse);
      expect(await abandoned.exists(), isFalse);
      expect(await store.deleteExpired(), 0);
    },
  );

  test(
    'file manifest index atomically retains manifest and hash refs',
    () async {
      final FileCacheStore cache = FileCacheStore(temp);
      final PlaybackManifest first = _manifest();
      final Map<String, String> refs = <String, String>{};
      for (final ClipDescriptor clip in first.clips) {
        final List<int> bytes = <int>[
          int.parse(clip.id.substring(5)) + 1,
          int.parse(clip.id.substring(5)) + 2,
          int.parse(clip.id.substring(5)) + 3,
        ];
        final CachedMedia media = await cache.commit(
          DownloadedMedia.fromBytes(clipId: clip.id, bytes: bytes),
        );
        refs[clip.sha256] = media.localRef;
      }
      final FileManifestIndexStore store = FileManifestIndexStore(
        Directory('${temp.path}${Platform.pathSeparator}indexes'),
      );
      final CommittedManifestIndex firstIndex = CommittedManifestIndex(
        manifest: first,
        clipHashToLocalRef: refs,
      );
      await store.writeAtomically(firstIndex);
      expect(
        await store.readCommitted(
          partyId: first.partyId,
          channelId: first.channelId,
        ),
        isNotNull,
      );

      final PlaybackManifest second = _manifest(version: 2);
      await store.writeAtomically(
        CommittedManifestIndex(manifest: second, clipHashToLocalRef: refs),
      );
      final CommittedManifestIndex? loaded = await store.readCommitted(
        partyId: second.partyId,
        channelId: second.channelId,
      );
      expect(loaded?.committedVersion, 2);
      expect(loaded?.manifest, equals(second));
      expect(loaded?.clipHashToLocalRef, refs);
      expect(loaded?.localRefFor(second.clips.first), isNotEmpty);
    },
  );

  test(
    'deleteExpired keeps media referenced by the committed offline index',
    () async {
      final DateTime now = DateTime.utc(2026, 10, 29, 12);
      final Directory cacheRoot = Directory(
        '${temp.path}${Platform.pathSeparator}cache',
      );
      final FileCacheStore cache = FileCacheStore(
        cacheRoot,
        maxAge: const Duration(days: 1),
        now: () => now,
      );
      final PlaybackManifest manifest = _manifest();
      final Map<String, String> refs = <String, String>{};
      for (final ClipDescriptor clip in manifest.clips) {
        final int index = int.parse(clip.id.substring(5));
        final List<int> bytes = <int>[index + 1, index + 2, index + 3];
        final CachedMedia entry = await cache.commit(
          DownloadedMedia.fromBytes(clipId: clip.id, bytes: bytes),
        );
        refs[clip.sha256] = entry.localRef;
        await File(
          entry.localRef,
        ).setLastModified(now.subtract(const Duration(days: 2)));
      }
      final FileManifestIndexStore indexStore = FileManifestIndexStore(
        Directory('${cacheRoot.path}${Platform.pathSeparator}indexes'),
      );
      await indexStore.writeAtomically(
        CommittedManifestIndex(manifest: manifest, clipHashToLocalRef: refs),
      );

      expect(await cache.deleteExpired(), 0);
      for (final String ref in refs.values) {
        expect(await File(ref).exists(), isTrue);
      }
    },
  );
}
