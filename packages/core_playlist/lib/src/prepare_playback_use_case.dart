import 'dart:async';

import 'package:rxdart/rxdart.dart';

import 'package:core_cache/core_cache.dart';
import 'package:core_foundation/core_foundation.dart';

import 'entities.dart';
import 'ports.dart';

/// Status of an individual clip during preparation.
class ClipLoadStatus {
  ClipLoadStatus.ready({required this.item, required this.file, required this.fromCache})
      : failure = null;

  ClipLoadStatus.failed({required this.item, required this.failure})
      : file = null,
        fromCache = false;

  final ClipItem item;
  final FileRef? file;
  final bool fromCache;
  final Failure? failure;

  bool get isReady => file != null;
  bool get isSignalLost => failure != null;
}

sealed class PreparePlaybackState {
  const PreparePlaybackState();
}

class PreparePlaybackLoading extends PreparePlaybackState {
  const PreparePlaybackLoading(this.version);

  final int version;
}

class PreparePlaybackPartial extends PreparePlaybackState {
  const PreparePlaybackPartial(this.version, this.statuses, this.overlay, this.expiresAt);

  final int version;
  final List<ClipLoadStatus> statuses;
  final OverlayConfig overlay;
  final DateTime expiresAt;
}

class PreparePlaybackReady extends PreparePlaybackState {
  const PreparePlaybackReady(this.playlist, {this.isStale = false});

  final PreparedPlaylist playlist;
  final bool isStale;
}

/// Use case responsible for preparing playback by ensuring all clips are locally cached.
class PreparePlaybackUseCase {
  PreparePlaybackUseCase({
    required PlaylistPort playlistPort,
    required CachePort cachePort,
    required MediaFetchPort mediaFetchPort,
  })  : _playlistPort = playlistPort,
        _cachePort = cachePort,
        _mediaFetchPort = mediaFetchPort;

  final PlaylistPort _playlistPort;
  final CachePort _cachePort;
  final MediaFetchPort _mediaFetchPort;

  Stream<PreparePlaybackState> execute(String partyId) {
    final BehaviorSubject<PreparePlaybackState> controller = BehaviorSubject<PreparePlaybackState>();
    PreparedPlaylist? lastReady;

    late final StreamSubscription<Playlist> sub;
    sub = _playlistPort.watchCurrent(partyId).listen(
      (Playlist playlist) async {
        controller.add(PreparePlaybackLoading(playlist.version));

        final Failure? validationError = _validatePlaylist(playlist);
        if (validationError != null) {
          controller.add(
            PreparePlaybackPartial(
              playlist.version,
              playlist.clips
                  .map(
                    (ClipItem clip) => ClipLoadStatus.failed(item: clip, failure: validationError),
                  )
                  .toList(growable: false),
              playlist.overlay,
              playlist.expiresAt,
            ),
          );
          return;
        }

        final List<ClipLoadStatus> statuses = <ClipLoadStatus>[];
        bool anyDownloaded = false;

        for (final ClipItem clip in playlist.clips) {
          try {
            final FileRef? cached = await _cachePort.get(clip.localKey);
            if (cached != null && cached.checksum == clip.checksumSha256) {
              statuses.add(ClipLoadStatus.ready(item: clip, file: cached, fromCache: true));
              continue;
            }

            if (clip.sizeBytes > _maxClipSizeBytes) {
              statuses.add(
                ClipLoadStatus.failed(
                  item: clip,
                  failure: ValidationFailure(
                    'Clip ${clip.id} exceeds maximum allowed size ($_maxClipSizeBytes).',
                  ),
                ),
              );
              continue;
            }

            final FileRef fetched = await _mediaFetchPort.prefetch(
              ClipRef(localKey: clip.localKey, signedUrl: clip.signedUrl, sizeBytes: clip.sizeBytes),
              checksum: clip.checksumSha256,
            );
            statuses.add(ClipLoadStatus.ready(item: clip, file: fetched, fromCache: false));
            anyDownloaded = true;
          } catch (Object error, StackTrace stack) {
            statuses.add(
              ClipLoadStatus.failed(
                item: clip,
                failure: CacheFailure('Failed to prepare clip ${clip.id}', cause: error, stackTrace: stack),
              ),
            );
          }
        }

        if (statuses.every((ClipLoadStatus status) => status.isReady)) {
          final PreparedPlaylist prepared = PreparedPlaylist(
            version: playlist.version,
            files: statuses
                .map(
                  (ClipLoadStatus status) => PreparedClip(item: status.item, file: status.file!),
                )
                .toList(growable: false),
            source: anyDownloaded ? PreparedSource.downloaded : PreparedSource.cache,
            overlay: playlist.overlay,
            expiresAt: playlist.expiresAt,
          );
          lastReady = prepared;
          controller.add(
            PreparePlaybackReady(
              prepared,
              isStale: DateTime.now().isAfter(playlist.expiresAt),
            ),
          );
        } else {
          controller.add(PreparePlaybackPartial(playlist.version, statuses, playlist.overlay, playlist.expiresAt));
          if (lastReady != null) {
            controller.add(
              PreparePlaybackReady(
                lastReady!,
                isStale: true,
              ),
            );
          }
        }
      },
      onError: controller.addError,
      onDone: controller.close,
    );

    controller.onCancel = () async {
      await sub.cancel();
    };

    return controller.stream;
  }

  static const int _maxClipSizeBytes = 20 * 1024 * 1024;

  Failure? _validatePlaylist(Playlist playlist) {
    if (playlist.clips.length != CoreConstants.requiredClipCount) {
      return ValidationFailure('Playlist must contain exactly four clips.');
    }
    if (!playlist.clips.hasUniqueLocalKeys()) {
      return ValidationFailure('Playlist clips must have unique cache keys.');
    }
    return null;
  }
}
