import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kernel_app/kernel_app.dart';

void main() {
  test('retry delay grows exponentially, adds jitter, and caps at max', () {
    final CappedExponentialBackoff halfJitter = CappedExponentialBackoff(
      initialDelay: const Duration(milliseconds: 400),
      maxDelay: const Duration(seconds: 2),
      randomUnit: () => 0.5,
    );
    expect(halfJitter.delayFor(1), const Duration(milliseconds: 200));
    expect(halfJitter.delayFor(2), const Duration(milliseconds: 400));
    expect(halfJitter.delayFor(3), const Duration(milliseconds: 800));
    expect(halfJitter.delayFor(20), const Duration(seconds: 1));

    final CappedExponentialBackoff fullJitter = CappedExponentialBackoff(
      initialDelay: const Duration(milliseconds: 400),
      maxDelay: const Duration(seconds: 2),
      randomUnit: () => 1,
    );
    expect(fullJitter.delayFor(20), const Duration(seconds: 2));
  });

  test('snapshot freezes its verified media map and reports completeness', () {
    final PlaybackManifest manifest = PlaybackManifest(
      partyId: 'p',
      channelId: 'cctv',
      version: 1,
      publishedAt: DateTime.utc(2026),
      clips: <ClipDescriptor>[
        for (var i = 1; i <= 4; i++)
          ClipDescriptor(
            id: 'clip-$i',
            cameraId: 'CAM-0$i',
            storageObjectId: 'obj-$i',
            sha256: '$i' * 64,
            sizeBytes: 1,
            duration: const Duration(seconds: 1),
            mimeType: 'video/mp4',
          ),
      ],
    );
    final Map<String, CachedMedia> input = <String, CachedMedia>{
      for (var i = 1; i <= 4; i++)
        'clip-$i': CachedMedia(
          clipId: 'clip-$i',
          localRef: 'opaque:$i',
          sha256: '$i' * 64,
        ),
    };
    final PlaybackSyncSnapshot snapshot = PlaybackSyncSnapshot(
      state: PlaybackSyncState.usingCache,
      manifest: manifest,
      mediaByClipId: input,
    );
    input.clear();
    expect(snapshot.hasCompleteMedia, isTrue);
    expect(snapshot.mediaByClipId, hasLength(4));
    expect(() => snapshot.mediaByClipId.clear(), throwsUnsupportedError);
    expect(PlaybackSyncState.values.map((state) => state.name), <String>[
      'booting',
      'usingCache',
      'preparing',
      'ready',
      'errorRecoverable',
      'errorFatal',
    ]);
  });

  test('backoff rejects invalid attempt and random inputs', () {
    final CappedExponentialBackoff invalidRandom = CappedExponentialBackoff(
      randomUnit: () => 1.1,
    );
    expect(() => invalidRandom.delayFor(1), throwsStateError);
    expect(() => invalidRandom.delayFor(0), throwsArgumentError);
  });
}
