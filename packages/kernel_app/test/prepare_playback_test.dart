import 'dart:async';

import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_signed_urls/infra_signed_urls.dart';
import 'package:kernel_app/kernel_app.dart';

final class _ManifestSource implements ManifestSource<PlaybackManifest> {
  _ManifestSource(this.manifest);

  final PlaybackManifest manifest;

  @override
  Stream<PlaybackManifest> watchCurrent({
    required String partyId,
    required String channelId,
  }) async* {
    yield manifest;
  }
}

final class _UrlSigner implements UrlSigner {
  final List<String> signedClipIds = <String>[];

  @override
  Future<Uri> signFor(
    ClipDescriptor clip, {
    Duration expiry = const Duration(hours: 1),
  }) async {
    signedClipIds.add(clip.id);
    return Uri.parse('https://media.test/${clip.storageObjectId}');
  }
}

final class _Downloader implements MediaDownloader {
  final Set<String> failures = <String>{};
  final Map<String, List<int>> corruptPayloads = <String, List<int>>{};
  final Map<String, Completer<void>> blocked = <String, Completer<void>>{};
  final Map<String, Completer<void>> started = <String, Completer<void>>{};
  int active = 0;
  int maxActive = 0;
  int downloadCount = 0;

  @override
  Future<DownloadedMedia> downloadAndVerify(
    ClipDescriptor clip,
    Uri source,
  ) async {
    downloadCount++;
    active++;
    if (active > maxActive) {
      maxActive = active;
    }
    final Completer<void>? startedSignal = started[clip.id];
    if (startedSignal != null && !startedSignal.isCompleted) {
      startedSignal.complete();
    }
    try {
      final Completer<void>? gate = blocked.remove(clip.id);
      if (gate != null) {
        await gate.future;
      }
      if (failures.contains(clip.id)) {
        throw StateError('interrupted download for ${clip.id}');
      }
      await Future<void>.delayed(const Duration(milliseconds: 1));
      final List<int> bytes = corruptPayloads[clip.id] ?? _bytesFor(clip);
      return DownloadedMedia.fromBytes(clipId: clip.id, bytes: bytes);
    } finally {
      active--;
    }
  }
}

final class _CacheStore implements CacheStore {
  final Map<String, CachedMedia> entries = <String, CachedMedia>{};
  final Map<String, List<int>> bytesByRef = <String, List<int>>{};

  String _key(ClipDescriptor clip) => '${clip.id}/${clip.sha256.toLowerCase()}';

  @override
  Future<CachedMedia?> findVerified(ClipDescriptor clip) async {
    final CachedMedia? entry = entries[_key(clip)];
    final List<int>? bytes = entry == null ? null : bytesByRef[entry.localRef];
    if (entry == null ||
        bytes == null ||
        bytes.length != clip.sizeBytes ||
        sha256Hex(bytes) != clip.sha256.toLowerCase()) {
      return null;
    }
    return entry;
  }

  @override
  Future<CachedMedia> commit(DownloadedMedia media) async {
    if (sha256Hex(media.bytes) != media.sha256.toLowerCase()) {
      throw StateError('cache refused a bad digest');
    }
    final String ref = 'mem://${media.clipId}/${media.sha256.toLowerCase()}';
    final CachedMedia entry = CachedMedia(
      clipId: media.clipId,
      localRef: ref,
      sha256: media.sha256.toLowerCase(),
    );
    entries['${media.clipId}/${media.sha256.toLowerCase()}'] = entry;
    bytesByRef[ref] = List<int>.unmodifiable(media.bytes);
    return entry;
  }

  @override
  Future<int> deleteExpired() async => 0;
}

final class _IndexStore implements ManifestIndexStore {
  final Map<String, CommittedManifestIndex> indexes =
      <String, CommittedManifestIndex>{};

  String _key(String partyId, String channelId) => '$partyId/$channelId';

  @override
  Future<CommittedManifestIndex?> readCommitted({
    required String partyId,
    required String channelId,
  }) async => indexes[_key(partyId, channelId)];

  @override
  Future<void> writeAtomically(CommittedManifestIndex index) async {
    if (failWrites) {
      throw StateError('atomic index write failed');
    }
    indexes[_key(index.manifest.partyId, index.manifest.channelId)] = index;
  }

  bool failWrites = false;
}

final class _AckRecord {
  _AckRecord(this.partyId, this.channelId, this.version, this.hashes);

  final String partyId;
  final String channelId;
  final int version;
  final Map<String, String> hashes;
}

final class _Acknowledger implements DeliveryAcknowledger {
  final List<_AckRecord> records = <_AckRecord>[];
  Object? failure;

  @override
  Future<void> acknowledge({
    required String partyId,
    required String channelId,
    required int manifestVersion,
    required Map<String, String> verifiedClipHashes,
  }) async {
    final Object? currentFailure = failure;
    failure = null;
    if (currentFailure != null) {
      throw currentFailure;
    }
    records.add(
      _AckRecord(
        partyId,
        channelId,
        manifestVersion,
        Map<String, String>.unmodifiable(verifiedClipHashes),
      ),
    );
  }
}

final class _PlaybackHandle implements PlaybackHandle {
  int prepareCount = 0;
  int activateCount = 0;
  bool failPrepare = false;

  @override
  Future<void> prepare() async {
    prepareCount++;
    if (failPrepare) {
      throw StateError('staged player could not prepare');
    }
  }

  @override
  Future<void> activate() async => activateCount++;
}

List<int> _bytesFor(ClipDescriptor clip) {
  final List<String> parts = clip.storageObjectId.split('-');
  final int version = int.parse(parts.first.substring(1));
  final int cameraNumber = int.parse(parts[2].split('.').first);
  final int firstByte = cameraNumber + version * 20;
  return <int>[firstByte, firstByte + 10, firstByte + 20];
}

PlaybackManifest _manifest({int version = 1, List<ClipDescriptor>? clips}) {
  final List<ClipDescriptor> selected =
      clips ??
      <ClipDescriptor>[
        for (var i = 1; i <= 4; i++)
          ClipDescriptor(
            id: 'clip-$i',
            cameraId: 'CAM-0$i',
            storageObjectId: 'v$version-camera-$i.mp4',
            sha256: sha256Hex(<int>[
              i + version * 20,
              i + version * 20 + 10,
              i + version * 20 + 20,
            ]),
            sizeBytes: 3,
            duration: const Duration(seconds: 5),
            mimeType: 'video/mp4',
          ),
      ];
  return PlaybackManifest(
    partyId: 'party-1',
    channelId: 'cctv',
    version: version,
    clips: selected,
    publishedAt: DateTime.utc(2026, 10, 29, version),
  );
}

PreparePlayback _useCase({
  required _CacheStore cache,
  required _IndexStore index,
  required _Downloader downloader,
  required _Acknowledger acknowledger,
  _ManifestSource? source,
  _UrlSigner? signer,
}) => PreparePlayback(
  manifestSource: source ?? _ManifestSource(_manifest()),
  urlSigner: signer ?? _UrlSigner(),
  downloader: downloader,
  cacheStore: cache,
  manifestIndexStore: index,
  acknowledger: acknowledger,
  backoff: CappedExponentialBackoff(randomUnit: () => 1),
);

void main() {
  test(
    'prepare, activate, ACK, then boot offline from committed index',
    () async {
      final _CacheStore cache = _CacheStore();
      final _IndexStore indexes = _IndexStore();
      final _Downloader downloader = _Downloader();
      final _Acknowledger ack = _Acknowledger();
      final _UrlSigner signer = _UrlSigner();
      final PreparePlayback service = _useCase(
        cache: cache,
        index: indexes,
        downloader: downloader,
        acknowledger: ack,
        source: _ManifestSource(_manifest()),
        signer: signer,
      );
      addTearDown(service.dispose);

      expect(service.snapshot.state, PlaybackSyncState.booting);
      final PlaybackSyncSnapshot prepared = await service.prepareLatest(
        partyId: 'party-1',
        channelId: 'cctv',
      );
      expect(prepared.state, PlaybackSyncState.ready);
      expect(prepared.hasCompleteMedia, isTrue);
      expect(prepared.mediaByClipId, hasLength(4));
      expect(indexes.indexes.values.single.committedVersion, 1);
      expect(ack.records, hasLength(1));
      expect(ack.records.single.hashes, hasLength(4));
      expect(downloader.maxActive, lessThanOrEqualTo(2));

      final _PlaybackHandle handle = _PlaybackHandle();
      final PlaybackSyncSnapshot active = await service.activate(handle);
      expect(active.state, PlaybackSyncState.ready);
      expect(handle.prepareCount, 1);
      expect(handle.activateCount, 1);

      final _Downloader offlineDownloader = _Downloader();
      final _UrlSigner offlineSigner = _UrlSigner();
      final PreparePlayback offline = _useCase(
        cache: cache,
        index: indexes,
        downloader: offlineDownloader,
        acknowledger: _Acknowledger(),
        signer: offlineSigner,
      );
      addTearDown(offline.dispose);
      final PlaybackSyncSnapshot cached = await offline.bootOffline(
        partyId: 'party-1',
        channelId: 'cctv',
      );
      expect(cached.state, PlaybackSyncState.usingCache);
      expect(cached.hasCompleteMedia, isTrue);
      expect(offlineDownloader.maxActive, 0);
      expect(offlineSigner.signedClipIds, isEmpty);
    },
  );

  test(
    'shuffled manifests ACK hashes by camera id instead of list position',
    () async {
      final _CacheStore cache = _CacheStore();
      final _IndexStore indexes = _IndexStore();
      final _Downloader downloader = _Downloader();
      final _Acknowledger ack = _Acknowledger();
      final List<ClipDescriptor> shuffled = _manifest().clips.reversed.toList();
      final PreparePlayback service = _useCase(
        cache: cache,
        index: indexes,
        downloader: downloader,
        acknowledger: ack,
      );
      addTearDown(service.dispose);

      final PlaybackManifest manifest = _manifest(clips: shuffled);
      expect(
        (await service.prepareManifest(manifest)).state,
        PlaybackSyncState.ready,
      );
      expect(ack.records.single.hashes, <String, String>{
        for (final ClipDescriptor clip in manifest.clips)
          clip.cameraId: clip.sha256,
      });
      expect(ack.records.single.hashes.values.toSet(), hasLength(4));
    },
  );

  test(
    'lost ACK response retries committed version without downloading again',
    () async {
      final _CacheStore cache = _CacheStore();
      final _IndexStore indexes = _IndexStore();
      final _Downloader downloader = _Downloader();
      final _Acknowledger ack = _Acknowledger()
        ..failure = StateError('ACK response was lost');
      final PreparePlayback service = _useCase(
        cache: cache,
        index: indexes,
        downloader: downloader,
        acknowledger: ack,
      );
      addTearDown(service.dispose);
      final PlaybackManifest manifest = _manifest();

      final PlaybackSyncSnapshot first = await service.prepareManifest(
        manifest,
      );
      expect(first.state, PlaybackSyncState.errorRecoverable);
      expect(first.hasCompleteMedia, isTrue);
      expect(indexes.indexes.values.single.committedVersion, 1);
      final int downloadsAfterFirstCommit = downloader.downloadCount;

      final PlaybackSyncSnapshot retried = await service.prepareManifest(
        manifest,
      );
      expect(retried.state, PlaybackSyncState.ready);
      expect(downloader.downloadCount, downloadsAfterFirstCommit);
      expect(ack.records, hasLength(1));
      expect(ack.records.single.version, 1);
    },
  );

  test(
    'ACK rejection keeps verified playback available for a later retry',
    () async {
      final _CacheStore cache = _CacheStore();
      final _IndexStore indexes = _IndexStore();
      final _Downloader downloader = _Downloader();
      final _Acknowledger ack = _Acknowledger()
        ..failure = StateError('backend rejected ACK');
      final PreparePlayback service = _useCase(
        cache: cache,
        index: indexes,
        downloader: downloader,
        acknowledger: ack,
      );
      addTearDown(service.dispose);
      final PlaybackManifest manifest = _manifest();

      final PlaybackSyncSnapshot rejected = await service.prepareManifest(
        manifest,
      );
      expect(rejected.state, PlaybackSyncState.errorRecoverable);
      expect(rejected.hasCompleteMedia, isTrue);
      expect(indexes.indexes.values.single.committedVersion, 1);
      expect(ack.records, isEmpty);
      final int downloads = downloader.downloadCount;

      final PlaybackSyncSnapshot retried = await service.prepareManifest(
        manifest,
      );
      expect(retried.state, PlaybackSyncState.ready);
      expect(downloader.downloadCount, downloads);
      expect(ack.records.single.version, 1);
    },
  );

  test('failed atomic index write cannot ACK verified clip files', () async {
    final _CacheStore cache = _CacheStore();
    final _IndexStore indexes = _IndexStore()..failWrites = true;
    final _Downloader downloader = _Downloader();
    final _Acknowledger ack = _Acknowledger();
    final PreparePlayback service = _useCase(
      cache: cache,
      index: indexes,
      downloader: downloader,
      acknowledger: ack,
    );
    addTearDown(service.dispose);

    final PlaybackSyncSnapshot failed = await service.prepareManifest(
      _manifest(),
    );
    expect(failed.state, PlaybackSyncState.errorRecoverable);
    expect(indexes.indexes, isEmpty);
    expect(ack.records, isEmpty);
  });

  test(
    'corrupt download keeps previous playback and committed version',
    () async {
      final _CacheStore cache = _CacheStore();
      final _IndexStore indexes = _IndexStore();
      final _Downloader downloader = _Downloader();
      final _Acknowledger ack = _Acknowledger();
      final PreparePlayback service = _useCase(
        cache: cache,
        index: indexes,
        downloader: downloader,
        acknowledger: ack,
      );
      addTearDown(service.dispose);

      final PlaybackManifest first = _manifest();
      expect(
        (await service.prepareManifest(first)).state,
        PlaybackSyncState.ready,
      );
      final _PlaybackHandle original = _PlaybackHandle();
      await service.activate(original);

      downloader.corruptPayloads['clip-2'] = <int>[99, 98, 97];
      final PlaybackSyncSnapshot failed = await service.prepareManifest(
        _manifest(version: 2),
      );
      expect(failed.state, PlaybackSyncState.errorRecoverable);
      expect(failed.manifest?.version, 1);
      expect(failed.mediaByClipId, hasLength(4));
      expect(indexes.indexes.values.single.committedVersion, 1);
      expect(ack.records.map((record) => record.version), <int>[1]);
      expect(original.activateCount, 1);
    },
  );

  test(
    'download failure leaves last-known-good index and provides retry delay',
    () async {
      final _CacheStore cache = _CacheStore();
      final _IndexStore indexes = _IndexStore();
      final _Downloader downloader = _Downloader();
      final _Acknowledger ack = _Acknowledger();
      final PreparePlayback service = _useCase(
        cache: cache,
        index: indexes,
        downloader: downloader,
        acknowledger: ack,
      );
      addTearDown(service.dispose);
      await service.prepareManifest(_manifest());

      downloader.failures.add('clip-3');
      final PlaybackSyncSnapshot failed = await service.prepareManifest(
        _manifest(version: 2),
      );
      expect(failed.state, PlaybackSyncState.errorRecoverable);
      expect(failed.retryAfter, const Duration(milliseconds: 500));
      final PlaybackSyncSnapshot retried = await service.prepareManifest(
        _manifest(version: 2),
      );
      expect(retried.state, PlaybackSyncState.errorRecoverable);
      expect(retried.retryAfter, const Duration(milliseconds: 1000));
      expect(indexes.indexes.values.single.committedVersion, 1);
      expect(ack.records.map((record) => record.version), <int>[1]);
    },
  );

  test(
    'cancel interrupts a partial download before index commit or ACK',
    () async {
      final _CacheStore cache = _CacheStore();
      final _IndexStore indexes = _IndexStore();
      final _Downloader downloader = _Downloader();
      final Completer<void> blocked = Completer<void>();
      final Completer<void> started = Completer<void>();
      downloader.blocked['clip-1'] = blocked;
      downloader.started['clip-1'] = started;
      final _Acknowledger ack = _Acknowledger();
      final PreparePlayback service = _useCase(
        cache: cache,
        index: indexes,
        downloader: downloader,
        acknowledger: ack,
      );
      addTearDown(service.dispose);

      final Future<PlaybackSyncSnapshot> pending = service.prepareManifest(
        _manifest(),
      );
      await started.future;
      service.cancel();
      blocked.complete();
      await pending;

      expect(service.snapshot.state, PlaybackSyncState.booting);
      expect(indexes.indexes, isEmpty);
      expect(ack.records, isEmpty);
    },
  );

  test(
    'newer racing manifest wins; delayed stale completion cannot ACK',
    () async {
      final _CacheStore cache = _CacheStore();
      final _IndexStore indexes = _IndexStore();
      final _Downloader downloader = _Downloader();
      final Completer<void> blocked = Completer<void>();
      final Completer<void> started = Completer<void>();
      downloader.blocked['clip-1'] = blocked;
      downloader.started['clip-1'] = started;
      final _Acknowledger ack = _Acknowledger();
      final PreparePlayback service = _useCase(
        cache: cache,
        index: indexes,
        downloader: downloader,
        acknowledger: ack,
      );
      addTearDown(service.dispose);

      final Future<PlaybackSyncSnapshot> stale = service.prepareManifest(
        _manifest(version: 2),
      );
      await started.future;
      final PlaybackSyncSnapshot newest = await service.prepareManifest(
        _manifest(version: 3),
      );
      blocked.complete();
      await stale;

      expect(newest.state, PlaybackSyncState.ready);
      expect(indexes.indexes.values.single.committedVersion, 3);
      expect(ack.records.map((record) => record.version), <int>[3]);
      expect(downloader.maxActive, lessThanOrEqualTo(2));

      final PlaybackSyncSnapshot rejected = await service.prepareManifest(
        _manifest(version: 2),
      );
      expect(rejected.state, PlaybackSyncState.errorRecoverable);
      expect(indexes.indexes.values.single.committedVersion, 3);
    },
  );

  test(
    'invalid camera assignment is fatal and does not replace current version',
    () async {
      final _CacheStore cache = _CacheStore();
      final _IndexStore indexes = _IndexStore();
      final _Downloader downloader = _Downloader();
      final _Acknowledger ack = _Acknowledger();
      final PreparePlayback service = _useCase(
        cache: cache,
        index: indexes,
        downloader: downloader,
        acknowledger: ack,
      );
      addTearDown(service.dispose);
      await service.prepareManifest(_manifest());
      final PlaybackManifest valid = _manifest(version: 2);
      final List<ClipDescriptor> duplicatedCamera = <ClipDescriptor>[
        ...valid.clips,
      ];
      duplicatedCamera[3] = ClipDescriptor(
        id: 'bad-camera',
        cameraId: 'CAM-01',
        storageObjectId: 'bad.mp4',
        sha256: sha256Hex(<int>[9, 9, 9]),
        sizeBytes: 3,
        duration: const Duration(seconds: 5),
        mimeType: 'video/mp4',
      );

      final PlaybackSyncSnapshot invalid = await service.prepareManifest(
        _manifest(version: 2, clips: duplicatedCamera),
      );
      expect(invalid.state, PlaybackSyncState.errorFatal);
      expect(invalid.manifest?.version, 1);
      expect(indexes.indexes.values.single.committedVersion, 1);
      expect(ack.records.map((record) => record.version), <int>[1]);
    },
  );
}
