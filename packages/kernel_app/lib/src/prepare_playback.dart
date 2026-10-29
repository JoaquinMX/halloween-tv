/// Offline-first CCTV playback preparation (Technical Design v1.0 §8.3).
library;

import 'dart:async';

import 'package:channel_api/channel_api.dart';
import 'package:core_cache/core_cache.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:infra_signed_urls/infra_signed_urls.dart';

import 'package:kernel_app/src/playback_sync.dart';

/// Stages complete, verified manifest versions and leaves activation to the
/// caller, which supplies a fresh [PlaybackHandle] for the staged media.
///
/// The previous complete snapshot is retained while a new version downloads.
/// Cancellation invalidates in-flight work; incomplete versions never replace
/// the durable manifest index or become eligible for activation.
final class PreparePlayback {
  /// Creates a preparation use case from domain ports.
  PreparePlayback({
    required ManifestSource<PlaybackManifest> manifestSource,
    required UrlSigner urlSigner,
    required MediaDownloader downloader,
    required CacheStore cacheStore,
    required ManifestIndexStore manifestIndexStore,
    required DeliveryAcknowledger acknowledger,
    CappedExponentialBackoff? backoff,
  }) : _manifestSource = manifestSource,
       _urlSigner = urlSigner,
       _downloader = downloader,
       _cacheStore = cacheStore,
       _manifestIndexStore = manifestIndexStore,
       _acknowledger = acknowledger,
       _backoff = backoff ?? CappedExponentialBackoff();

  static const int maxConcurrentDownloads = 2;

  final ManifestSource<PlaybackManifest> _manifestSource;
  final UrlSigner _urlSigner;
  final MediaDownloader _downloader;
  final CacheStore _cacheStore;
  final ManifestIndexStore _manifestIndexStore;
  final DeliveryAcknowledger _acknowledger;
  final CappedExponentialBackoff _backoff;
  final StreamController<PlaybackSyncSnapshot> _changes =
      StreamController<PlaybackSyncSnapshot>.broadcast();
  final _AsyncSemaphore _downloadSlots = _AsyncSemaphore(
    maxConcurrentDownloads,
  );

  PlaybackSyncSnapshot _snapshot = PlaybackSyncSnapshot(
    state: PlaybackSyncState.booting,
  );
  PlaybackSyncSnapshot? _lastComplete;
  PlaybackSyncSnapshot? _lastActive;
  int _operation = 0;
  int _highestRequestedVersion = 0;
  int _recoverableFailures = 0;
  Future<void> _indexWriteTail = Future<void>.value();

  /// Current preparation state and any retained complete media.
  PlaybackSyncSnapshot get snapshot => _snapshot;

  /// Emits every state transition.
  Stream<PlaybackSyncSnapshot> get changes => _changes.stream;

  /// Loads and verifies the last atomically committed version without network.
  Future<PlaybackSyncSnapshot> bootOffline({
    required String partyId,
    required String channelId,
  }) async {
    final int token = ++_operation;
    _emit(PlaybackSyncSnapshot(state: PlaybackSyncState.booting));
    try {
      final CommittedManifestIndex? index = await _manifestIndexStore
          .readCommitted(partyId: partyId, channelId: channelId);
      if (token != _operation) {
        return _snapshot;
      }
      if (index == null) {
        return _recoverable('no committed offline manifest is available');
      }
      final PlaybackManifest manifest = index.manifest;
      if (manifest.partyId != partyId || manifest.channelId != channelId) {
        return _fatal('committed manifest belongs to a different scope');
      }
      final Result<PlaybackManifest> validation = validateCctvManifest(
        manifest,
      );
      if (validation.isErr) {
        return _fatal((validation as Err<PlaybackManifest>).message);
      }
      final Map<String, CachedMedia> media = await _verifiedEntriesForIndex(
        index,
      );
      if (token != _operation) {
        return _snapshot;
      }
      if (media.length != manifest.clips.length) {
        return _recoverable('committed offline media is missing or corrupt');
      }
      final PlaybackSyncSnapshot result = PlaybackSyncSnapshot(
        state: PlaybackSyncState.usingCache,
        manifest: manifest,
        mediaByClipId: media,
      );
      _recoverableFailures = 0;
      _highestRequestedVersion = manifest.version;
      _lastComplete = result;
      _emit(result);
      return result;
    } on Object catch (error) {
      return _recoverable('offline cache could not be read: $error');
    }
  }

  /// Fetches the first current manifest for [partyId]/[channelId] and stages it.
  Future<PlaybackSyncSnapshot> prepareLatest({
    required String partyId,
    required String channelId,
  }) async {
    final int token = ++_operation;
    _emit(_preparingSnapshot());
    try {
      final PlaybackManifest manifest = await _manifestSource
          .watchCurrent(partyId: partyId, channelId: channelId)
          .firstWhere(
            (PlaybackManifest value) =>
                value.partyId == partyId && value.channelId == channelId,
          );
      if (token != _operation) {
        return _snapshot;
      }
      return await prepareManifest(manifest);
    } on Object catch (error) {
      if (token != _operation) {
        return _snapshot;
      }
      return _recoverable('manifest source failed: $error');
    }
  }

  /// Validates and stages [manifest], preserving the previous complete version
  /// until all four clips and the new durable index have been committed.
  Future<PlaybackSyncSnapshot> prepareManifest(
    PlaybackManifest manifest,
  ) async {
    final Result<PlaybackManifest> validation = validateCctvManifest(manifest);
    if (validation.isErr) {
      return _fatal((validation as Err<PlaybackManifest>).message);
    }

    if (manifest.version < _highestRequestedVersion) {
      return _recoverable(
        'stale manifest version ${manifest.version}; '
        'newer version $_highestRequestedVersion was already requested',
      );
    }
    final int token = ++_operation;
    _highestRequestedVersion = manifest.version;
    _emit(_preparingSnapshot());

    try {
      final CommittedManifestIndex? previous = await _manifestIndexStore
          .readCommitted(
            partyId: manifest.partyId,
            channelId: manifest.channelId,
          );
      if (token != _operation) {
        return _snapshot;
      }
      if (previous != null && manifest.version < previous.committedVersion) {
        return _recoverable(
          'manifest version ${manifest.version} is older than committed '
          'version ${previous.committedVersion}',
        );
      }
      if (previous != null && manifest.version == previous.committedVersion) {
        if (previous.manifest != manifest) {
          return _recoverable(
            'manifest version ${manifest.version} conflicts with its '
            'committed content',
          );
        }
        final Map<String, CachedMedia> cached = await _verifiedEntriesForIndex(
          previous,
        );
        if (cached.length != manifest.clips.length) {
          return _recoverable(
            'committed manifest contains missing or corrupt media',
          );
        }
        if (token != _operation) {
          return _snapshot;
        }
        final PlaybackSyncSnapshot cachedSnapshot = PlaybackSyncSnapshot(
          state: PlaybackSyncState.ready,
          manifest: manifest,
          mediaByClipId: cached,
        );
        _recoverableFailures = 0;
        _lastComplete = cachedSnapshot;
        _emit(cachedSnapshot);
        await _acknowledgeIfCurrent(manifest, token);
        return _snapshot;
      }
      final Result<PlaybackManifest> monotonic = validateManifestVersion(
        manifest,
        previous?.committedVersion,
      );
      if (monotonic.isErr) {
        return _recoverable((monotonic as Err<PlaybackManifest>).message);
      }

      final List<CachedMedia?> staged = List<CachedMedia?>.filled(
        manifest.clips.length,
        null,
      );
      await _stageClips(manifest, staged, token);
      if (token != _operation) {
        return _snapshot;
      }
      final Map<String, CachedMedia> mediaByClipId = <String, CachedMedia>{};
      final Map<String, String> clipHashToLocalRef = <String, String>{};
      for (var i = 0; i < manifest.clips.length; i++) {
        final ClipDescriptor clip = manifest.clips[i];
        final CachedMedia? media = staged[i];
        if (media == null ||
            media.clipId != clip.id ||
            media.sha256.toLowerCase() != clip.sha256.toLowerCase() ||
            media.localRef.trim().isEmpty) {
          throw StateError(
            'clip ${clip.id} did not produce a verified cache entry',
          );
        }
        mediaByClipId[clip.id] = media;
        clipHashToLocalRef[clip.sha256.toLowerCase()] = media.localRef;
      }
      final CommittedManifestIndex index = CommittedManifestIndex(
        manifest: manifest,
        clipHashToLocalRef: clipHashToLocalRef,
      );
      final bool committed = await _commitIndexIfCurrent(index, token);
      if (token != _operation) {
        return _snapshot;
      }
      if (!committed) {
        return _recoverable('a newer manifest version was committed');
      }
      final PlaybackSyncSnapshot complete = PlaybackSyncSnapshot(
        state: PlaybackSyncState.ready,
        manifest: manifest,
        mediaByClipId: mediaByClipId,
      );
      _recoverableFailures = 0;
      _lastComplete = complete;
      _emit(complete);
      await _acknowledgeIfCurrent(manifest, token);
      return _snapshot;
    } on Object catch (error) {
      if (token != _operation) {
        return _snapshot;
      }
      return _recoverable('playback preparation failed: $error');
    }
  }

  /// Activates a fresh handle only after it has been prepared from a complete
  /// snapshot. The caller keeps its current handle alive until this succeeds.
  Future<PlaybackSyncSnapshot> activate(PlaybackHandle stagedHandle) async {
    final PlaybackSyncSnapshot target = _snapshot.hasCompleteMedia
        ? _snapshot
        : (_lastComplete ?? _snapshot);
    if (!target.hasCompleteMedia) {
      return _recoverable('no complete playback version is ready to activate');
    }
    final int token = _operation;
    try {
      await stagedHandle.prepare();
      if (token != _operation) {
        return _snapshot;
      }
      await stagedHandle.activate();
      if (token != _operation) {
        return _snapshot;
      }
      final PlaybackSyncSnapshot active = PlaybackSyncSnapshot(
        state: PlaybackSyncState.ready,
        manifest: target.manifest,
        mediaByClipId: target.mediaByClipId,
      );
      _lastActive = active;
      _lastComplete = active;
      _emit(active);
      return active;
    } on Object catch (error) {
      return _recoverable('playback activation failed: $error');
    }
  }

  /// Invalidates current asynchronous work and restores the last complete view.
  void cancel() {
    _operation++;
    final PlaybackSyncSnapshot? retained = _lastActive ?? _lastComplete;
    if (retained == null) {
      _emit(PlaybackSyncSnapshot(state: PlaybackSyncState.booting));
      return;
    }
    _emit(
      PlaybackSyncSnapshot(
        state: _lastActive == null
            ? PlaybackSyncState.usingCache
            : PlaybackSyncState.ready,
        manifest: retained.manifest,
        mediaByClipId: retained.mediaByClipId,
      ),
    );
  }

  /// Closes the state stream.
  Future<void> dispose() => _changes.close();

  Future<void> _stageClips(
    PlaybackManifest manifest,
    List<CachedMedia?> staged,
    int token,
  ) async {
    var next = 0;
    Object? firstError;
    Future<void> worker() async {
      while (true) {
        if (token != _operation || firstError != null) {
          return;
        }
        final int index = next++;
        if (index >= manifest.clips.length) {
          return;
        }
        final ClipDescriptor clip = manifest.clips[index];
        try {
          CachedMedia? cached = await _cacheStore.findVerified(clip);
          if (token != _operation) {
            return;
          }
          if (cached == null) {
            final Uri source = await _urlSigner.signFor(clip);
            if (token != _operation) {
              return;
            }
            final DownloadedMedia download = await _downloadSlots.withPermit(
              () => _downloader.downloadAndVerify(clip, source),
            );
            if (token != _operation) {
              return;
            }
            if (download.clipId != clip.id || !download.matchesClip(clip)) {
              throw FormatException(
                'download for ${clip.id} failed byte-count or SHA-256 checks',
              );
            }
            cached = await _cacheStore.commit(download);
          }
          if (cached.clipId != clip.id ||
              cached.sha256.toLowerCase() != clip.sha256.toLowerCase() ||
              cached.localRef.trim().isEmpty) {
            throw StateError('cache returned an invalid entry for ${clip.id}');
          }
          staged[index] = cached;
        } on Object catch (error) {
          firstError ??= error;
        }
      }
    }

    await Future.wait<void>(<Future<void>>[worker(), worker()]);
    if (firstError != null) {
      throw firstError!;
    }
  }

  Future<Map<String, CachedMedia>> _verifiedEntriesForIndex(
    CommittedManifestIndex index,
  ) async {
    final Map<String, CachedMedia> result = <String, CachedMedia>{};
    for (final ClipDescriptor clip in index.manifest.clips) {
      final CachedMedia? media = await _cacheStore.findVerified(clip);
      if (media == null ||
          media.clipId != clip.id ||
          media.sha256.toLowerCase() != clip.sha256.toLowerCase() ||
          media.localRef != index.localRefFor(clip)) {
        continue;
      }
      result[clip.id] = media;
    }
    return result;
  }

  Future<bool> _commitIndexIfCurrent(
    CommittedManifestIndex candidate,
    int token,
  ) async {
    final Completer<void> release = Completer<void>();
    final Future<void> predecessor = _indexWriteTail;
    _indexWriteTail = release.future;
    await predecessor;
    try {
      if (token != _operation) {
        return false;
      }
      final CommittedManifestIndex? current = await _manifestIndexStore
          .readCommitted(
            partyId: candidate.manifest.partyId,
            channelId: candidate.manifest.channelId,
          );
      if (token != _operation) {
        return false;
      }
      if (current != null &&
          candidate.committedVersion <= current.committedVersion) {
        return current.manifest == candidate.manifest;
      }
      await _manifestIndexStore.writeAtomically(candidate);
      return token == _operation;
    } finally {
      release.complete();
    }
  }

  Future<void> _acknowledgeIfCurrent(
    PlaybackManifest manifest,
    int token,
  ) async {
    if (token != _operation) {
      return;
    }
    try {
      await _acknowledger.acknowledge(
        partyId: manifest.partyId,
        channelId: manifest.channelId,
        manifestVersion: manifest.version,
        verifiedClipHashes: <String>[
          for (final ClipDescriptor clip in manifest.clips)
            clip.sha256.toLowerCase(),
        ],
      );
    } on Object catch (error) {
      if (token == _operation) {
        _recoverable('delivery acknowledgement failed: $error');
      }
    }
  }

  PlaybackSyncSnapshot _preparingSnapshot() => PlaybackSyncSnapshot(
    state: PlaybackSyncState.preparing,
    manifest: _lastComplete?.manifest,
    mediaByClipId:
        _lastComplete?.mediaByClipId ?? const <String, CachedMedia>{},
  );

  PlaybackSyncSnapshot _fatal(String message) {
    final PlaybackSyncSnapshot failure = PlaybackSyncSnapshot(
      state: PlaybackSyncState.errorFatal,
      manifest: _lastComplete?.manifest,
      mediaByClipId:
          _lastComplete?.mediaByClipId ?? const <String, CachedMedia>{},
      error: message,
    );
    _emit(failure);
    return failure;
  }

  PlaybackSyncSnapshot _recoverable(String message) {
    _recoverableFailures++;
    final PlaybackSyncSnapshot failure = PlaybackSyncSnapshot(
      state: PlaybackSyncState.errorRecoverable,
      manifest: _lastComplete?.manifest,
      mediaByClipId:
          _lastComplete?.mediaByClipId ?? const <String, CachedMedia>{},
      error: message,
      retryAfter: _backoff.delayFor(_recoverableFailures),
    );
    _emit(failure);
    return failure;
  }

  void _emit(PlaybackSyncSnapshot next) {
    _snapshot = next;
    if (!_changes.isClosed) {
      _changes.add(next);
    }
  }
}

final class _AsyncSemaphore {
  _AsyncSemaphore(this.limit);

  final int limit;
  final List<Completer<void>> _waiters = <Completer<void>>[];
  int _inUse = 0;

  Future<T> withPermit<T>(Future<T> Function() action) async {
    if (_inUse >= limit) {
      final Completer<void> waiter = Completer<void>();
      _waiters.add(waiter);
      await waiter.future;
    } else {
      _inUse++;
    }
    try {
      return await action();
    } finally {
      if (_waiters.isEmpty) {
        _inUse--;
      } else {
        _waiters.removeAt(0).complete();
      }
    }
  }
}
