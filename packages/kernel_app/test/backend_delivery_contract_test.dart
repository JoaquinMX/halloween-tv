import 'dart:convert';
import 'dart:io';

import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_firestore/infra_firestore.dart';
import 'package:infra_signed_urls/infra_signed_urls.dart';
import 'package:kernel_app/kernel_app.dart';

import '../../infra_signed_urls/test/support/https_fixture_server.dart';

final class _BackendCallable
    implements FirebaseCallableInvoker, FirebaseManifestCallableInvoker {
  _BackendCallable({required this.fixture});

  final Map<String, Object?> fixture;
  final List<(String, Map<String, Object?>)> calls =
      <(String, Map<String, Object?>)>[];
  int deliveryRequestCount = 0;
  late Map<String, Object?> currentDocument;
  int currentDeliveryVersion = 2;
  String? contentMismatchCamera;
  String? corruptCamera;
  bool rejectAcknowledgements = false;
  Future<void> Function(Map<String, Object?> payload)? onAcknowledgement;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    calls.add((name, Map<String, Object?>.of(payload)));
    if (name == 'getCurrentManifest') {
      return currentDocument;
    }
    if (name == 'getDeliveryUrls') {
      deliveryRequestCount++;
      final Map<String, Object?> response = Map<String, Object?>.from(
        fixture['deliveryUrlsResponse']! as Map,
      );
      response['manifestVersion'] = currentDeliveryVersion;
      response['manifestHash'] = 'f' * 64;
      response['clips'] = <Map<String, Object?>>[
        for (final CctvSlot slot in cctvSlots) _deliveryClip(slot.id),
      ];
      return response;
    }
    if (name == 'acknowledgeDelivery') {
      await onAcknowledgement?.call(payload);
      if (rejectAcknowledgements) {
        throw StateError('backend rejected stale acknowledgement');
      }
      return <String, Object?>{
        'ackId': 'ack-${payload['manifestVersion']}',
        'manifestVersion': payload['manifestVersion'],
        'purged': true,
      };
    }
    throw StateError('unexpected callable $name');
  }

  Map<String, Object?> _deliveryClip(String cameraId) {
    final List<Object?> clips =
        currentDocument['cameraClips']! as List<Object?>;
    final Map<String, Object?> clip = Map<String, Object?>.from(
      clips.cast<Map<Object?, Object?>>().singleWhere(
        (Map<Object?, Object?> value) => value['cameraId'] == cameraId,
      ),
    );
    final bool isMismatch = cameraId == contentMismatchCamera;
    final String hash = isMismatch ? 'e' * 64 : clip['sha256']! as String;
    final String path;
    if (deliveryRequestCount <= 2) {
      path = '/expired/$cameraId';
    } else if (cameraId == corruptCamera) {
      path = '/corrupt/$cameraId';
    } else {
      path = '/fresh/$cameraId';
    }
    return <String, Object?>{
      'cameraId': cameraId,
      'sha256': hash,
      'url': _server!.uriFor(path).toString(),
      'expiresAt': '2030-01-01T00:00:00.000Z',
    };
  }

  HttpsFixtureServer? _server;

  set server(HttpsFixtureServer value) => _server = value;
}

Map<String, Object?> _readFixture() => Map<String, Object?>.from(
  jsonDecode(
        File('../../test/fixtures/backend_contract_v1.json').readAsStringSync(),
      )
      as Map,
);

Map<String, Object?> _backendManifest({
  required Map<String, Object?> fixture,
  required int version,
  required Map<String, List<int>> bytesByCamera,
}) {
  final Map<String, Object?> template = Map<String, Object?>.from(
    fixture['manifest']! as Map,
  );
  final String partyId = template['partyId']! as String;
  final String channelId = template['channelId']! as String;
  template['version'] = version;
  template['createdAt'] = DateTime.utc(2026, 10, 29, version).toIso8601String();
  template['expiresAt'] = '2030-01-01T00:00:00.000Z';
  template['cameraClips'] = <Map<String, Object?>>[
    for (final CctvSlot slot in cctvSlots)
      <String, Object?>{
        'cameraId': slot.id,
        'objectPath':
            'parties/$partyId/channels/$channelId/delivery/$version/${slot.id}.mp4',
        'sha256': sha256Hex(bytesByCamera[slot.id]!),
        'sizeBytes': bytesByCamera[slot.id]!.length,
        'durationMs': 2000,
        'expiresAt': '2030-01-01T00:00:00.000Z',
      },
  ];
  return template;
}

Map<String, List<int>> _bytesForVersion(int version) => <String, List<int>>{
  for (final CctvSlot slot in cctvSlots)
    slot.id: <int>[version, slot.index + 10, slot.index + 20, version + 30],
};

void main() {
  test(
    'shared backend fixture flows through manifest mapping, HTTPS delivery, durable cache, ACK and offline restore',
    () async {
      final Map<String, Object?> fixture = _readFixture();
      final Map<String, List<int>> v1Bytes = _bytesForVersion(1);
      final Map<String, List<int>> v2Bytes = _bytesForVersion(2);
      final Map<String, List<int>> httpBodies = <String, List<int>>{
        for (final CctvSlot slot in cctvSlots)
          '/fresh/${slot.id}': v1Bytes[slot.id]!,
        '/corrupt/CAM-03': <int>[0, 0, 0, 0],
      };
      final Map<String, HttpsFixtureResponse> responses =
          <String, HttpsFixtureResponse>{
            for (final CctvSlot slot in cctvSlots)
              '/expired/${slot.id}': const HttpsFixtureResponse(
                statusCode: HttpStatus.forbidden,
              ),
            for (final CctvSlot slot in cctvSlots)
              '/fresh/${slot.id}': HttpsFixtureResponse(
                statusCode: HttpStatus.ok,
                body: httpBodies['/fresh/${slot.id}']!,
              ),
            '/corrupt/CAM-03': HttpsFixtureResponse(
              statusCode: HttpStatus.ok,
              body: httpBodies['/corrupt/CAM-03']!,
            ),
          };
      final HttpsFixtureServer server = await HttpsFixtureServer.start(
        responses: responses,
      );
      final HttpClient httpClient = testHttpClient();
      final Directory root = await Directory.systemTemp.createTemp(
        'backend-delivery-contract-',
      );
      final Directory indexRoot = Directory('${root.path}/indexes');
      try {
        final _BackendCallable callable = _BackendCallable(fixture: fixture)
          ..server = server;
        callable.currentDocument = _backendManifest(
          fixture: fixture,
          version: 1,
          bytesByCamera: v1Bytes,
        );
        final FirebaseManifestSource manifestSource = FirebaseManifestSource(
          watchDocumentData: FirebaseCallableManifestTransport(
            identity: FirebaseTvIdentity(
              partyId: 'pilot',
              deviceId: 'tv-pilot',
            ),
            callableInvoker: callable,
            pollInterval: const Duration(seconds: 1),
          ).watchDocumentData,
        );
        final FirebaseDeliveryClient delivery = FirebaseDeliveryClient(
          identity: FirebaseTvIdentity(partyId: 'pilot', deviceId: 'tv-pilot'),
          callableInvoker: callable,
          now: () => DateTime.utc(2026, 10, 29),
        );
        final FirebaseUrlSigner signer = FirebaseUrlSigner(
          deliveryClient: delivery,
          channelId: 'main',
        );
        final FileCacheStore cache = FileCacheStore(root, indexRoot: indexRoot);
        final FileManifestIndexStore indexes = FileManifestIndexStore(
          indexRoot,
        );
        callable.onAcknowledgement = (Map<String, Object?> payload) async {
          final CommittedManifestIndex? committed = await indexes.readCommitted(
            partyId: 'pilot',
            channelId: 'main',
          );
          if (committed == null ||
              committed.committedVersion != payload['manifestVersion']) {
            throw StateError('ACK arrived before the atomic index commit');
          }
          final PlaybackManifest mapped = manifestFromFirestore(
            callable.currentDocument,
          );
          for (final ClipDescriptor clip in mapped.clips) {
            if (await cache.findVerified(clip) == null) {
              throw StateError(
                'ACK arrived before ${clip.cameraId} was committed',
              );
            }
          }
        };
        var urlRefreshCount = 0;
        final List<Uri> refreshedUris = <Uri>[];
        final PreparePlayback service = PreparePlayback(
          manifestSource: manifestSource,
          urlSigner: signer,
          downloader: HttpsMediaDownloader(
            httpClient: httpClient,
            expiredUrlRefresher: (clip, _) async {
              urlRefreshCount++;
              final Uri uri = await signer.signFor(clip);
              refreshedUris.add(uri);
              return uri;
            },
          ),
          cacheStore: cache,
          manifestIndexStore: indexes,
          acknowledger: delivery,
        );
        addTearDown(service.dispose);

        final PlaybackSyncSnapshot ready = await service.prepareLatest(
          partyId: 'pilot',
          channelId: 'main',
        );
        expect(ready.state, PlaybackSyncState.ready, reason: ready.error);
        expect(ready.manifest?.version, 1);
        expect(callable.currentDeliveryVersion, 2);
        expect(urlRefreshCount, 2);
        expect(
          refreshedUris.every((Uri uri) => uri.path.startsWith('/fresh/')),
          isTrue,
        );
        final CommittedManifestIndex committedV1 = (await indexes.readCommitted(
          partyId: 'pilot',
          channelId: 'main',
        ))!;
        for (final ClipDescriptor clip in ready.manifest!.clips) {
          final File media = File(committedV1.localRefFor(clip)!);
          expect(await media.readAsBytes(), v1Bytes[clip.cameraId]);
          expect(await media.exists(), isTrue);
        }
        expect(
          callable.calls.where((call) => call.$1 == 'getDeliveryUrls').length,
          6,
          reason: 'the first two expired URLs are refreshed once',
        );
        final List<FileSystemEntity> durableIndexes = await indexRoot
            .list()
            .toList();
        expect(durableIndexes.whereType<File>(), hasLength(1));
        expect(committedV1.clipHashToLocalRef, hasLength(4));
        final Map<String, Object?> fixtureAck = Map<String, Object?>.from(
          fixture['ack']! as Map,
        );
        final Map<String, String> expectedAckHashes = <String, String>{
          for (final ClipDescriptor clip in ready.manifest!.clips)
            clip.cameraId: clip.sha256,
        };
        expect(expectedAckHashes.keys.toSet(), <String>{
          for (final CctvSlot slot in cctvSlots) slot.id,
        });
        final (String ackName, Map<String, Object?> ackPayload) = callable.calls
            .singleWhere((call) => call.$1 == 'acknowledgeDelivery');
        expect(ackName, 'acknowledgeDelivery');
        expect(ackPayload, <String, Object?>{
          ...fixtureAck,
          'clipHashes': expectedAckHashes,
          'manifestVersion': 1,
        });

        callable.rejectAcknowledgements = true;
        final PlaybackSyncSnapshot staleAckRejected = await service
            .prepareManifest(ready.manifest!);
        expect(staleAckRejected.state, PlaybackSyncState.errorRecoverable);
        expect(staleAckRejected.manifest?.version, 1);
        expect(staleAckRejected.mediaByClipId, hasLength(4));
        expect(
          (await indexes.readCommitted(partyId: 'pilot', channelId: 'main'))
              ?.committedVersion,
          1,
        );
        expect(callable.calls.last.$2['manifestVersion'], 1);
        callable.rejectAcknowledgements = false;

        final ClipDescriptor changedCamera = ClipDescriptor(
          id: 'changed-cam-04',
          cameraId: 'CAM-04',
          storageObjectId: 'parties/pilot/changed.mp4',
          sha256: sha256Hex(<int>[9, 9, 9, 9]),
          sizeBytes: 4,
          duration: const Duration(seconds: 2),
          mimeType: 'video/mp4',
        );
        callable.contentMismatchCamera = 'CAM-04';
        await expectLater(
          delivery.refreshUrlFor(channelId: 'main', clip: changedCamera),
          throwsStateError,
        );
        callable.contentMismatchCamera = null;
        callable.deliveryRequestCount = 0;

        callable.currentDeliveryVersion = 2;
        callable.corruptCamera = 'CAM-03';
        callable.currentDocument = _backendManifest(
          fixture: fixture,
          version: 2,
          bytesByCamera: v2Bytes,
        );
        for (final CctvSlot slot in cctvSlots) {
          responses['/fresh/${slot.id}'] = HttpsFixtureResponse(
            statusCode: HttpStatus.ok,
            body: v2Bytes[slot.id]!,
          );
        }
        final PlaybackSyncSnapshot failedV2 = await service.prepareLatest(
          partyId: 'pilot',
          channelId: 'main',
        );
        expect(failedV2.state, PlaybackSyncState.errorRecoverable);
        expect(failedV2.manifest?.version, 1);
        expect(
          (await indexes.readCommitted(
            partyId: 'pilot',
            channelId: 'main',
          ))?.committedVersion,
          1,
        );
        expect(
          callable.calls
              .where((call) => call.$1 == 'acknowledgeDelivery')
              .map((call) => call.$2['manifestVersion']),
          <int>[1, 1],
        );

        final int callableCountBeforeOffline = callable.calls.length;
        final PreparePlayback secondInstance = PreparePlayback(
          manifestSource: FirebaseManifestSource(
            watchDocumentData: (_) =>
                throw StateError('offline restore requested the network'),
          ),
          urlSigner: signer,
          downloader: HttpsMediaDownloader(httpClient: httpClient),
          cacheStore: FileCacheStore(root, indexRoot: indexRoot),
          manifestIndexStore: FileManifestIndexStore(indexRoot),
          acknowledger: delivery,
        );
        addTearDown(secondInstance.dispose);
        final PlaybackSyncSnapshot restored = await secondInstance.bootOffline(
          partyId: 'pilot',
          channelId: 'main',
        );
        expect(restored.state, PlaybackSyncState.usingCache);
        expect(restored.manifest?.version, 1);
        expect(restored.mediaByClipId, hasLength(4));
        expect(callable.calls, hasLength(callableCountBeforeOffline));
      } finally {
        httpClient.close(force: true);
        await server.close();
        await root.delete(recursive: true);
      }
    },
  );
}
