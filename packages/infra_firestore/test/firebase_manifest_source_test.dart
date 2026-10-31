import 'package:cloud_firestore/cloud_firestore.dart';

import 'dart:async';

import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_firestore/infra_firestore.dart';

Map<String, Object?> backendManifest({
  Object? schemaVersion = 1,
  String partyId = 'pilot',
  String channelId = 'main',
  int count = 4,
}) => <String, Object?>{
  'schemaVersion': schemaVersion,
  'partyId': partyId,
  'channelId': channelId,
  'version': 3,
  'jobId': 'job-3',
  'createdAt': Timestamp.fromDate(DateTime.utc(2026, 10, 29, 13, 0)),
  'expiresAt': '2026-10-30T13:00:00.000Z',
  'cameraClips': <Map<String, Object?>>[
    for (final int index in List<int>.generate(count, (i) => i + 1))
      <String, Object?>{
        'cameraId': 'CAM-0$index',
        'objectPath': 'parties/pilot/channels/main/delivery/3/CAM-0$index.mp4',
        'sha256': String.fromCharCode(96 + index) * 64,
        'sizeBytes': 1000 + index,
        'durationMs': 2000,
        'expiresAt': '2026-10-30T13:00:00.000Z',
      },
  ],
};

void main() {
  const String manifestPath = 'parties/pilot/manifests/current_main';

  FirebaseManifestSource sourceFor(
    Stream<Map<String, Object?>?> Function(String path) watch,
  ) => FirebaseManifestSource(
    watchDocumentData: watch,
    now: () => DateTime.utc(2026, 10, 29, 14),
  );

  test(
    'watches current_{channel}, normalizes Timestamp and maps backend v1',
    () async {
      String? watchedPath;
      final FirebaseManifestSource source = sourceFor((String path) {
        watchedPath = path;
        return Stream<Map<String, Object?>?>.value(backendManifest());
      });

      final manifest = await source
          .watchCurrent(partyId: 'pilot', channelId: 'main')
          .first;

      expect(manifest.partyId, 'pilot');
      expect(watchedPath, manifestPath);
      expect(manifest.channelId, 'main');
      expect(manifest.version, 3);
      expect(manifest.publishedAt, DateTime.utc(2026, 10, 29, 13));
      expect(manifest.clips, hasLength(4));
      expect(manifest.clips.first.cameraId, 'CAM-01');
      expect(
        manifest.clips.first.storageObjectId,
        'parties/pilot/channels/main/delivery/3/CAM-01.mp4',
      );
      expect(manifest.clips.first.mimeType, 'video/mp4');
    },
  );

  test('rejects an unsupported schemaVersion from the live stream', () async {
    final FirebaseManifestSource source = sourceFor(
      (_) => Stream<Map<String, Object?>?>.value(
        backendManifest(schemaVersion: 2),
      ),
    );

    await expectLater(
      source.watchCurrent(partyId: 'pilot', channelId: 'main'),
      emitsError(isA<ManifestSchemaException>()),
    );
  });

  test(
    'rejects a document whose party or channel differs from the request',
    () async {
      final FirebaseManifestSource mismatchedParty = sourceFor(
        (_) => Stream<Map<String, Object?>?>.value(
          backendManifest(partyId: 'other-party'),
        ),
      );

      await expectLater(
        mismatchedParty.watchCurrent(partyId: 'pilot', channelId: 'main'),
        emitsError(isA<ManifestScopeException>()),
      );

      final FirebaseManifestSource mismatchedChannel = sourceFor(
        (_) => Stream<Map<String, Object?>?>.value(
          backendManifest(channelId: 'other-channel'),
        ),
      );

      await expectLater(
        mismatchedChannel.watchCurrent(partyId: 'pilot', channelId: 'main'),
        emitsError(isA<ManifestScopeException>()),
      );
    },
  );

  test(
    'a Firestore stream transport error is recoverable by the caller',
    () async {
      final FirebaseManifestSource source = FirebaseManifestSource(
        watchDocumentData: (_) =>
            Stream<Map<String, Object?>?>.error(StateError('offline')),
        maxTransportResubscriptions: 0,
        transportRetryDelay: Duration.zero,
      );
      await expectLater(
        source.watchCurrent(partyId: 'pilot', channelId: 'main'),
        emitsError(isA<ManifestTransportException>()),
      );
    },
  );

  test(
    'legacy backend timestamp fallback is stable across observations',
    () async {
      final Map<String, Object?> withoutCreatedAt = backendManifest()
        ..remove('createdAt');
      final FirebaseManifestSource source = sourceFor(
        (_) => Stream<Map<String, Object?>?>.fromIterable(
          <Map<String, Object?>?>[withoutCreatedAt, withoutCreatedAt],
        ),
      );

      final List<PlaybackManifest> manifest = await source
          .watchCurrent(partyId: 'pilot', channelId: 'main')
          .toList();

      expect(manifest, hasLength(2));
      expect(manifest[0].publishedAt, DateTime.utc(1970));
      expect(manifest[1], manifest[0]);
    },
  );

  test(
    '1/2/4-camera backend documents map through the real path and validate',
    () async {
      for (final int count in <int>[1, 2, 4]) {
        final FirebaseManifestSource source = sourceFor(
          (_) => Stream<Map<String, Object?>?>.value(
            backendManifest(count: count),
          ),
        );
        final PlaybackManifest manifest = await source
            .watchCurrent(partyId: 'pilot', channelId: 'main')
            .first;
        expect(manifest.clips, hasLength(count));
        expect(
          manifest.clips.map((clip) => clip.cameraId).toList(),
          expectedCctvCameraIds(count),
        );
        // Storage mapping carries the delivery object path and digest.
        expect(
          manifest.clips.first.storageObjectId,
          'parties/pilot/channels/main/delivery/3/CAM-01.mp4',
        );
        expect(validateCctvManifest(manifest).isOk, isTrue);
        // Durable-cache restoration shape: JSON round-trip keeps count.
        final PlaybackManifest restored = parseManifest(manifest.toJson());
        expect(restored.clips, hasLength(count));
        expect(validateCctvManifest(restored).isOk, isTrue);
      }
    },
  );

  test('3-camera and gapped backend documents fail validation', () async {
    final FirebaseManifestSource threeSource = sourceFor(
      (_) => Stream<Map<String, Object?>?>.value(backendManifest(count: 3)),
    );
    final PlaybackManifest three = await threeSource
        .watchCurrent(partyId: 'pilot', channelId: 'main')
        .first;
    expect(three.clips, hasLength(3));
    expect(validateCctvManifest(three).isErr, isTrue);

    final Map<String, Object?> gapped = backendManifest(count: 2);
    ((gapped['cameraClips']! as List)[1] as Map<String, Object?>)['cameraId'] =
        'CAM-03';
    final FirebaseManifestSource gapSource = sourceFor(
      (_) => Stream<Map<String, Object?>?>.value(gapped),
    );
    final PlaybackManifest gap = await gapSource
        .watchCurrent(partyId: 'pilot', channelId: 'main')
        .first;
    expect(validateCctvManifest(gap).isErr, isTrue);
  });
}
