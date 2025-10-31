import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:core_playlist/core_playlist.dart';
import 'package:testing_toolkit/testing_toolkit.dart';

void main() {
  group('Playlist validation', () {
    test('emits partial state when duplicate cache keys present', () async {
      final playlistPort = FakePlaylistPort();
      final Playlist playlist = Playlist(
        version: 1,
        overlay: const OverlayConfig(timestampFmt: 'yyyy', glitchIntensity: 0.1),
        expiresAt: DateTime.now(),
        clips: List<ClipItem>.generate(
          4,
          (int index) => ClipItem(
            id: 'clip$index',
            label: 'CAM-0$index',
            localKey: 'duplicate.mp4',
            signedUrl: 'https://example.com/$index',
            checksumSha256: 'hash',
            sizeBytes: 1024,
          ),
        ),
      );

      final useCase = PreparePlaybackUseCase(
        playlistPort: playlistPort,
        cachePort: FakeCachePort(),
        mediaFetchPort: FakeMediaFetchPort(FakeCachePort()),
      );

      final List<PreparePlaybackState> states = <PreparePlaybackState>[];
      final sub = useCase.execute('party').listen(states.add);
      playlistPort.emit(playlist);
      await Future<void>.delayed(const Duration(milliseconds: 10));
      await sub.cancel();

      expect(states.whereType<PreparePlaybackPartial>(), isNotEmpty);
    });
  });

  group('PreparePlaybackUseCase', () {
    late FakePlaylistPort playlistPort;
    late FakeCachePort cachePort;
    late FakeMediaFetchPort mediaFetchPort;
    late PreparePlaybackUseCase useCase;

    setUp(() {
      playlistPort = FakePlaylistPort();
      cachePort = FakeCachePort();
      mediaFetchPort = FakeMediaFetchPort(cachePort);
      useCase = PreparePlaybackUseCase(
        playlistPort: playlistPort,
        cachePort: cachePort,
        mediaFetchPort: mediaFetchPort,
      );
    });

    test('emits ready state when all clips downloaded', () async {
      final Playlist playlist = _buildPlaylist();
      for (final ClipItem clip in playlist.clips) {
        mediaFetchPort.seed(clip.localKey, Uint8List.fromList(List<int>.filled(4, 1)));
      }

      final List<PreparePlaybackState> states = <PreparePlaybackState>[];
      final stream = useCase.execute('party');
      final sub = stream.listen(states.add);
      playlistPort.emit(playlist);
      await Future<void>.delayed(const Duration(milliseconds: 10));
      await sub.cancel();

      expect(states.whereType<PreparePlaybackReady>(), isNotEmpty);
      final ready = states.whereType<PreparePlaybackReady>().first;
      expect(ready.playlist.files, hasLength(4));
    });

    test('emits partial state when fetch fails', () async {
      final Playlist playlist = _buildPlaylist();
      // Only seed first three clips.
      for (final ClipItem clip in playlist.clips.take(3)) {
        mediaFetchPort.seed(clip.localKey, Uint8List.fromList(List<int>.filled(4, 2)));
      }

      final List<PreparePlaybackState> states = <PreparePlaybackState>[];
      final sub = useCase.execute('party').listen(states.add);
      playlistPort.emit(playlist);
      await Future<void>.delayed(const Duration(milliseconds: 10));
      await sub.cancel();

      expect(states.whereType<PreparePlaybackPartial>(), isNotEmpty);
      final partial = states.whereType<PreparePlaybackPartial>().first;
      expect(partial.statuses.where((status) => status.isSignalLost), isNotEmpty);
    });
  });
}

Playlist _buildPlaylist() {
  return Playlist(
    version: 1,
    overlay: const OverlayConfig(timestampFmt: 'yyyy-MM-dd HH:mm:ss', glitchIntensity: 0.2),
    expiresAt: DateTime.now().add(const Duration(minutes: 30)),
    clips: List<ClipItem>.generate(
      4,
      (int index) => ClipItem(
        id: 'clip$index',
        label: 'CAM-0$index',
        localKey: 'cam$index.mp4',
        signedUrl: 'https://example.com/$index',
        checksumSha256: '9f04e4ec5a31b1be9d3d9e23c58f1',
        sizeBytes: 4,
      ),
    ),
  );
}
