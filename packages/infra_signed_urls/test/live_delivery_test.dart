import 'dart:io';

import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_firestore/infra_firestore.dart';
import 'package:infra_signed_urls/infra_signed_urls.dart';

import 'support/https_fixture_server.dart';

final class _CallableFake implements FirebaseCallableInvoker {
  _CallableFake(this.server, this.sha256);

  final HttpsFixtureServer server;
  final String sha256;
  final List<(String, Map<String, Object?>)> calls = [];

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    calls.add((name, Map<String, Object?>.of(payload)));
    if (name == 'getDeliveryUrls') {
      final bool refreshed =
          calls.where((call) => call.$1 == 'getDeliveryUrls').length > 1;
      return <String, Object?>{
        'manifestVersion': 7,
        'manifestHash': 'f' * 64,
        'clips': <Map<String, Object?>>[
          for (final CctvSlot slot in cctvSlots)
            <String, Object?>{
              'cameraId': slot.id,
              'sha256': sha256,
              'url': server
                  .uriFor(refreshed ? '/fresh' : '/expired')
                  .toString(),
              'expiresAt': '2030-01-01T00:00:00.000Z',
            },
        ],
      };
    }
    if (name == 'acknowledgeDelivery') {
      return <String, Object?>{
        'ackId': 'ack-7',
        'manifestVersion': payload['manifestVersion'],
        'purged': true,
      };
    }
    throw StateError('unexpected callable $name');
  }
}

void main() {
  test(
    'callable URL refresh and HTTPS download deliver verified bytes',
    () async {
      final List<int> bytes = <int>[1, 3, 5, 7, 9, 11];
      final String hash = sha256Hex(bytes);
      final HttpsFixtureServer server = await HttpsFixtureServer.start(
        responses: <String, HttpsFixtureResponse>{
          '/expired': const HttpsFixtureResponse(
            statusCode: HttpStatus.forbidden,
          ),
          '/fresh': HttpsFixtureResponse(
            statusCode: HttpStatus.ok,
            body: bytes,
          ),
        },
      );
      final HttpClient httpClient = testHttpClient();
      try {
        final _CallableFake callable = _CallableFake(server, hash);
        final FirebaseDeliveryClient delivery = FirebaseDeliveryClient(
          identity: FirebaseTvIdentity(partyId: 'pilot', deviceId: 'tv-pilot'),
          callableInvoker: callable,
          now: () => DateTime.utc(2026, 10, 29),
        );
        final FirebaseUrlSigner signer = FirebaseUrlSigner(
          deliveryClient: delivery,
          channelId: 'main',
        );
        final ClipDescriptor target = ClipDescriptor(
          id: 'cam-one',
          cameraId: 'CAM-01',
          storageObjectId: 'parties/pilot/delivery/CAM-01.mp4',
          sha256: hash,
          sizeBytes: bytes.length,
          duration: const Duration(seconds: 2),
          mimeType: 'video/mp4',
        );
        final Uri initialUrl = await signer.signFor(target);
        final Directory cacheRoot = await Directory.systemTemp.createTemp(
          'delivery-cache-',
        );
        try {
          final HttpsMediaDownloader downloader = HttpsMediaDownloader(
            httpClient: httpClient,
            expiredUrlRefresher: (clip, _) => signer.signFor(clip),
          );
          final CachedMedia cached = await downloader.downloadAndCommit(
            clip: target,
            source: initialUrl,
            cacheStore: FileCacheStore(cacheRoot),
          );

          expect(await File(cached.localRef).readAsBytes(), bytes);
          expect(cached.sha256, hash);
          expect(callable.calls.map((call) => call.$1), [
            'getDeliveryUrls',
            'getDeliveryUrls',
          ]);
          for (final (String name, Map<String, Object?> payload)
              in callable.calls) {
            expect(payload['partyId'], 'pilot');
            expect(payload['deviceId'], 'tv-pilot');
            expect(payload['channelId'], 'main');
            expect(name, 'getDeliveryUrls');
          }

          await delivery.acknowledge(
            partyId: 'pilot',
            channelId: 'main',
            manifestVersion: 7,
            verifiedClipHashes: <String, String>{
              'CAM-04': 'd' * 64,
              'CAM-02': 'b' * 64,
              'CAM-01': 'a' * 64,
              'CAM-03': 'c' * 64,
            },
          );
          final (String ackName, Map<String, Object?> ackPayload) =
              callable.calls.last;
          expect(ackName, 'acknowledgeDelivery');
          expect(ackPayload['clipHashes'], <String, String>{
            'CAM-01': 'a' * 64,
            'CAM-02': 'b' * 64,
            'CAM-03': 'c' * 64,
            'CAM-04': 'd' * 64,
          });
          expect(ackPayload['manifestVersion'], 7);
        } finally {
          await cacheRoot.delete(recursive: true);
        }
      } finally {
        httpClient.close(force: true);
        await server.close();
      }
    },
  );
}
