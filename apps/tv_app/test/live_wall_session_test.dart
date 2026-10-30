import 'dart:async';
import 'dart:io';

import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_signed_urls/infra_signed_urls.dart';
import 'package:kernel_app/kernel_app.dart';
import 'package:tv_app/src/wall/live_wall_session.dart';

const String _party = 'party-session-test';
const String _channel = 'haunted_surveillance';

final class _ManifestStream implements ManifestSource<PlaybackManifest> {
  bool cancelled = false;
  late final StreamController<PlaybackManifest> controller =
      StreamController<PlaybackManifest>.broadcast(
        onCancel: () {
          cancelled = true;
        },
      );

  @override
  Stream<PlaybackManifest> watchCurrent({
    required String partyId,
    required String channelId,
  }) => controller.stream;
}

final class _Signer implements UrlSigner {
  @override
  Future<Uri> signFor(
    ClipDescriptor clip, {
    Duration expiry = const Duration(hours: 1),
  }) async => Uri.https('delivery.invalid', '/${clip.id}');
}

final class _Downloader implements MediaDownloader {
  _Downloader(this.payloadFor, {this.delay = Duration.zero});

  final List<int> Function(ClipDescriptor clip) payloadFor;
  final Duration delay;
  int calls = 0;

  @override
  Future<DownloadedMedia> downloadAndVerify(
    ClipDescriptor clip,
    Uri source,
  ) async {
    calls++;
    if (delay > Duration.zero) await Future<void>.delayed(delay);
    return DownloadedMedia.fromBytes(clipId: clip.id, bytes: payloadFor(clip));
  }
}

final class _Acknowledger implements DeliveryAcknowledger {
  int calls = 0;
  int failuresRemaining;

  _Acknowledger({this.failuresRemaining = 0});

  @override
  Future<void> acknowledge({
    required String partyId,
    required String channelId,
    required int manifestVersion,
    required Map<String, String> verifiedClipHashes,
  }) async {
    calls++;
    if (failuresRemaining > 0) {
      failuresRemaining--;
      throw StateError('temporary ACK rejection');
    }
  }
}

List<int> _bundledBytes(int camera) => <int>[
  for (var i = 0; i < 37; i++) (camera * 13 + i) & 0xff,
];

List<int> _liveBytes(int camera, int version) => <int>[
  for (var i = 0; i < 73; i++) (camera * 19 + version * 43 + i) & 0xff,
];

PlaybackManifest _manifest(int version, List<int> Function(int) bytesFor) =>
    PlaybackManifest(
      partyId: _party,
      channelId: _channel,
      version: version,
      clips: <ClipDescriptor>[
        for (var i = 1; i <= 4; i++)
          ClipDescriptor(
            id: 'remote-$version-cam-$i',
            cameraId: 'CAM-0$i',
            storageObjectId: 'delivery/cam-0$i-v$version.mp4',
            sha256: sha256Hex(bytesFor(i)),
            sizeBytes: bytesFor(i).length,
            duration: const Duration(seconds: 2),
            mimeType: 'video/mp4',
          ),
      ],
      publishedAt: DateTime.utc(2026, 10, 29, 20, version),
    );

Future<void> _waitFor(bool Function() condition) async {
  final DateTime deadline = DateTime.now().add(const Duration(seconds: 3));
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      throw TimeoutException('condition was not met before the test deadline');
    }
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

Future<({PreparePlayback prepare, _Downloader downloader, _Acknowledger ack})>
_composition({
  required Directory root,
  required _ManifestStream source,
  required List<int> Function(ClipDescriptor) payloadFor,
  _Acknowledger? acknowledger,
  Duration downloadDelay = Duration.zero,
}) async {
  final Directory cacheRoot = Directory('${root.path}/media');
  final Directory indexRoot = Directory('${root.path}/index');
  await Future.wait<void>(<Future<void>>[
    cacheRoot.create(recursive: true),
    indexRoot.create(recursive: true),
  ]);
  final _Downloader downloader = _Downloader(payloadFor, delay: downloadDelay);
  final _Acknowledger ack = acknowledger ?? _Acknowledger();
  return (
    prepare: PreparePlayback(
      manifestSource: source,
      urlSigner: _Signer(),
      downloader: downloader,
      cacheStore: FileCacheStore(cacheRoot, indexRoot: indexRoot),
      manifestIndexStore: FileManifestIndexStore(indexRoot),
      acknowledger: ack,
      backoff: CappedExponentialBackoff(
        initialDelay: const Duration(milliseconds: 5),
        maxDelay: const Duration(milliseconds: 10),
        randomUnit: () => 1,
      ),
    ),
    downloader: downloader,
    ack: ack,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'stages different media than the bundled fixtures and restarts from disk',
    () async {
      final Directory root = await Directory.systemTemp.createTemp(
        'tv-live-disk-',
      );
      addTearDown(() => root.delete(recursive: true));
      final _ManifestStream source = _ManifestStream();
      final composition = await _composition(
        root: root,
        source: source,
        payloadFor: (ClipDescriptor clip) =>
            _liveBytes(int.parse(clip.cameraId.substring(4)), 1),
      );
      final PlaybackSyncSnapshot offline = await composition.prepare
          .bootOffline(partyId: _party, channelId: _channel);
      expect(offline.hasCompleteMedia, isFalse);

      final List<PlaybackSyncSnapshot> activated = <PlaybackSyncSnapshot>[];
      final LiveWallSession session = LiveWallSession(
        partyId: _party,
        channelId: _channel,
        manifestSource: source,
        preparation: composition.prepare,
      );
      session.start(
        activate: (PlaybackSyncSnapshot snapshot) async {
          activated.add(snapshot);
        },
      );
      final PlaybackManifest live = _manifest(
        1,
        (int camera) => _liveBytes(camera, 1),
      );
      source.controller.add(live);
      await _waitFor(() => activated.isNotEmpty);

      expect(activated.single.manifest!.version, 1);
      for (final ClipDescriptor clip in live.clips) {
        final CachedMedia media = activated.single.mediaByClipId[clip.id]!;
        expect(media.localRef, isNot(clip.storageObjectId));
        expect(
          await File(media.localRef).readAsBytes(),
          _liveBytes(int.parse(clip.cameraId.substring(4)), 1),
        );
        expect(
          sha256Hex(await File(media.localRef).readAsBytes()),
          clip.sha256,
        );
        expect(
          sha256Hex(_bundledBytes(int.parse(clip.cameraId.substring(4)))),
          isNot(clip.sha256),
        );
      }

      final PreparePlayback restarted = PreparePlayback(
        manifestSource: source,
        urlSigner: _Signer(),
        downloader: _Downloader(
          (ClipDescriptor clip) =>
              _liveBytes(int.parse(clip.cameraId.substring(4)), 1),
        ),
        cacheStore: FileCacheStore(
          Directory('${root.path}/media'),
          indexRoot: Directory('${root.path}/index'),
        ),
        manifestIndexStore: FileManifestIndexStore(
          Directory('${root.path}/index'),
        ),
        acknowledger: _Acknowledger(),
      );
      final PlaybackSyncSnapshot restartedSnapshot = await restarted
          .bootOffline(partyId: _party, channelId: _channel);
      expect(restartedSnapshot.state, PlaybackSyncState.usingCache);
      expect(restartedSnapshot.hasCompleteMedia, isTrue);
      expect(restartedSnapshot.manifest!.version, 1);

      await session.dispose();
      expect(source.cancelled, isTrue);
    },
  );

  test(
    'bad downloaded hashes and rejected ACKs never replace active playback',
    () async {
      final Directory root = await Directory.systemTemp.createTemp(
        'tv-live-failures-',
      );
      addTearDown(() => root.delete(recursive: true));
      final _ManifestStream badSource = _ManifestStream();
      final composition = await _composition(
        root: Directory('${root.path}/bad'),
        source: badSource,
        payloadFor: (ClipDescriptor clip) => <int>[0, 1, 2, 3],
      );
      final List<int> activations = <int>[];
      final LiveWallSession badSession = LiveWallSession(
        partyId: _party,
        channelId: _channel,
        manifestSource: badSource,
        preparation: composition.prepare,
      );
      badSession.start(
        activate: (PlaybackSyncSnapshot snapshot) async {
          activations.add(snapshot.manifest!.version);
        },
      );
      badSource.controller.add(
        _manifest(1, (int camera) => _liveBytes(camera, 1)),
      );
      await _waitFor(() => composition.downloader.calls > 0);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(activations, isEmpty);
      expect(
        await FileManifestIndexStore(
          Directory('${root.path}/bad/index'),
        ).readCommitted(partyId: _party, channelId: _channel),
        isNull,
      );
      await badSession.dispose();

      final _ManifestStream ackSource = _ManifestStream();
      final _Acknowledger ack = _Acknowledger(failuresRemaining: 1);
      final ackComposition = await _composition(
        root: Directory('${root.path}/ack'),
        source: ackSource,
        payloadFor: (ClipDescriptor clip) =>
            _liveBytes(int.parse(clip.cameraId.substring(4)), 2),
        acknowledger: ack,
      );
      final List<int> activeVersions = <int>[];
      final LiveWallSession ackSession = LiveWallSession(
        partyId: _party,
        channelId: _channel,
        manifestSource: ackSource,
        preparation: ackComposition.prepare,
      );
      ackSession.start(
        activate: (PlaybackSyncSnapshot snapshot) async {
          activeVersions.add(snapshot.manifest!.version);
        },
      );
      ackSource.controller.add(
        _manifest(2, (int camera) => _liveBytes(camera, 2)),
      );
      await _waitFor(() => activeVersions.isNotEmpty);
      expect(ack.calls, 2);
      expect(
        ackComposition.downloader.calls,
        4,
        reason: 'retry ACK reuses committed bytes',
      );
      expect(activeVersions, <int>[2]);
      await ackSession.dispose();
    },
  );

  test(
    'same-version conflicts and racing observations preserve monotonic media',
    () async {
      final Directory root = await Directory.systemTemp.createTemp(
        'tv-live-race-',
      );
      addTearDown(() => root.delete(recursive: true));
      final _ManifestStream source = _ManifestStream();
      final composition = await _composition(
        root: root,
        source: source,
        payloadFor: (ClipDescriptor clip) => _liveBytes(
          int.parse(clip.cameraId.substring(4)),
          int.parse(clip.storageObjectId.split('v').last.split('.').first),
        ),
        downloadDelay: const Duration(milliseconds: 10),
      );
      final List<int> activatedVersions = <int>[];
      final LiveWallSession session = LiveWallSession(
        partyId: _party,
        channelId: _channel,
        manifestSource: source,
        preparation: composition.prepare,
      );
      session.start(
        activate: (PlaybackSyncSnapshot snapshot) async {
          activatedVersions.add(snapshot.manifest!.version);
        },
      );
      final PlaybackManifest one = _manifest(
        1,
        (int camera) => _liveBytes(camera, 1),
      );
      source.controller.add(one);
      await _waitFor(() => activatedVersions.length == 1);

      source.controller.add(
        _manifest(1, (int camera) => _liveBytes(camera, 9)),
      );
      source.controller.add(
        _manifest(3, (int camera) => _liveBytes(camera, 3)),
      );
      source.controller.add(
        _manifest(2, (int camera) => _liveBytes(camera, 2)),
      );
      await _waitFor(
        () => activatedVersions.isNotEmpty && activatedVersions.last == 3,
      );
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(activatedVersions, contains(3));
      expect(activatedVersions.last, 3);

      final CommittedManifestIndex? committed = await FileManifestIndexStore(
        Directory('${root.path}/index'),
      ).readCommitted(partyId: _party, channelId: _channel);
      expect(committed?.manifest.version, 3);
      expect(
        committed!.manifest.clips.first.sha256,
        sha256Hex(_liveBytes(1, 3)),
        reason: 'conflicting v1 and a late v2 cannot replace v3',
      );
      await session.dispose();
      expect(source.cancelled, isTrue);
    },
  );

  test(
    'decoder activation failure is not retried against the same bytes',
    () async {
      final Directory root = await Directory.systemTemp.createTemp(
        'tv-live-decoder-failure-',
      );
      addTearDown(() => root.delete(recursive: true));
      final _ManifestStream source = _ManifestStream();
      final composition = await _composition(
        root: root,
        source: source,
        payloadFor: (ClipDescriptor clip) =>
            _liveBytes(int.parse(clip.cameraId.substring(4)), 4),
      );
      var activationAttempts = 0;
      final LiveWallSession session = LiveWallSession(
        partyId: _party,
        channelId: _channel,
        manifestSource: source,
        preparation: composition.prepare,
      );
      session.start(
        activate: (PlaybackSyncSnapshot snapshot) async {
          activationAttempts++;
          throw StateError('decoder failed and WallScreen rolled back');
        },
      );
      source.controller.add(
        _manifest(4, (int camera) => _liveBytes(camera, 4)),
      );
      await _waitFor(() => activationAttempts == 1);
      await Future<void>.delayed(const Duration(milliseconds: 30));

      expect(activationAttempts, 1);
      expect(composition.downloader.calls, 4);
      expect(
        composition.prepare.snapshot.state,
        PlaybackSyncState.errorRecoverable,
      );
      await session.dispose();
    },
  );
}
