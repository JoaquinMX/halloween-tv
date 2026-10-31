import 'dart:convert';
import 'dart:io';

import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_firestore/infra_firestore.dart';
import 'package:infra_signed_urls/infra_signed_urls.dart';

final class _FixtureCallable implements FirebaseCallableInvoker {
  _FixtureCallable(this.responses);

  final Map<String, Object?> responses;
  final List<(String, Map<String, Object?>)> calls =
      <(String, Map<String, Object?>)>[];

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    calls.add((name, Map<String, Object?>.of(payload)));
    return responses[name];
  }
}

Map<String, Object?> _fixture() => Map<String, Object?>.from(
  jsonDecode(
        File('../../test/fixtures/backend_contract_v1.json').readAsStringSync(),
      )
      as Map,
);

Map<String, Object?> _deliveryResponse({
  int version = 1,
  String? manifestHash,
  Map<String, String>? hashes,
}) => <String, Object?>{
  'manifestVersion': version,
  'manifestHash': manifestHash ?? 'c' * 64,
  'clips': <Map<String, Object?>>[
    for (final CctvSlot slot in cctvSlots)
      <String, Object?>{
        'cameraId': slot.id,
        'sha256':
            hashes?[slot.id] ?? String.fromCharCode(96 + slot.index + 1) * 64,
        'url': 'https://delivery.test/${slot.id}.mp4',
        'expiresAt': '2030-01-01T00:00:00.000Z',
      },
  ],
};

void main() {
  test('shared fixture ACK hashes match the backend canonical hash vector', () {
    final Map<String, Object?> fixture = _fixture();
    final Map<String, Object?> ack = Map<String, Object?>.from(
      (fixture['acknowledgeDelivery']! as Map)['request']! as Map,
    );
    final Map<String, String> hashes = Map<String, String>.from(
      ack['clipHashes']! as Map,
    );
    final List<Map<String, Object?>> cameraClips = <Map<String, Object?>>[
      for (final CctvSlot slot in cctvSlots)
        <String, Object?>{
          'cameraId': slot.id,
          'sha256': hashes[slot.id]!,
          'sizeBytes': 12345 + slot.index,
          'durationMs': 2000,
        },
    ];
    // This vector follows backend/functions/src/contracts.ts canonical field
    // order and excludes URL, path, expiry, job, and timestamp fields.
    // The digest below is a change-detector for the Dart-side reconstruction;
    // the oracle is backend/functions/test/backend_contract_fixture.test.ts,
    // which runs the real canonicalManifestHash over the same fixture.
    final String canonical = jsonEncode(<String, Object?>{
      'partyId': ack['partyId'],
      'channelId': ack['channelId'],
      'version': ack['manifestVersion'],
      'cameraClips': cameraClips,
    });

    expect(
      sha256Hex(utf8.encode(canonical)),
      'c3114a6601be504d1be045749e00512bc249aa70ca365b804e26695d94265692',
    );
  });

  test(
    'Dart parses exact getDeliveryUrls and acknowledgeDelivery contracts',
    () async {
      final Map<String, Object?> fixture = _fixture();
      final Map<String, Object?> hashByCamera = Map<String, Object?>.from(
        ((fixture['acknowledgeDelivery']! as Map)['request']! as Map)['clipHashes']! as Map,
      );
      final Map<String, String> hashes = <String, String>{
        for (final MapEntry<String, Object?> entry in hashByCamera.entries)
          entry.key: entry.value! as String,
      };
      final Map<String, Object?> deliveryFixture =
          Map<String, Object?>.from((fixture['deliveryUrls']! as Map)['response']! as Map)
            ..['manifestHash'] =
                'c3114a6601be504d1be045749e00512bc249aa70ca365b804e26695d94265692'
            ..['clips'] = _deliveryResponse(hashes: hashes)['clips'];
      final Map<String, Object?> fixtureAck = Map<String, Object?>.from(
        (fixture['acknowledgeDelivery']! as Map)['request']! as Map,
      )..['clipHashes'] = hashes;
      final _FixtureCallable invoker = _FixtureCallable(<String, Object?>{
        'getDeliveryUrls': deliveryFixture,
        'acknowledgeDelivery': <String, Object?>{
          'ackId': 'backend-ack-1',
          'manifestVersion': 1,
          'purged': true,
        },
      });
      final FirebaseDeliveryClient client = FirebaseDeliveryClient(
        identity: FirebaseTvIdentity(partyId: 'pilot', deviceId: 'tv-pilot'),
        callableInvoker: invoker,
        now: () => DateTime.utc(2026, 10, 29),
      );

      final FirebaseDeliveryUrls urls = await client.getDeliveryUrls(
        channelId: 'main',
      );
      expect(urls.manifestVersion, 1);
      expect(urls.manifestHash, deliveryFixture['manifestHash']);
      expect(
        urls.clips.map((FirebaseDeliveryClipUrl clip) => clip.cameraId),
        cctvSlots.map((CctvSlot slot) => slot.id),
      );
      await client.acknowledge(
        partyId: fixtureAck['partyId']! as String,
        channelId: fixtureAck['channelId']! as String,
        manifestVersion: fixtureAck['manifestVersion']! as int,
        verifiedClipHashes: hashes,
      );
      expect(invoker.calls.last.$1, 'acknowledgeDelivery');
      expect(invoker.calls.last.$2['clipHashes'], hashes);
    },
  );

  test(
    'URL reuse validates camera plus SHA-256, not unused manifest fields',
    () async {
      final Map<String, String> hashes = <String, String>{
        for (final CctvSlot slot in cctvSlots)
          slot.id: String.fromCharCode(96 + slot.index + 1) * 64,
      };
      final _FixtureCallable invoker = _FixtureCallable(<String, Object?>{
        'getDeliveryUrls': _deliveryResponse(
          version: 99,
          manifestHash: 'f' * 64,
          hashes: hashes,
        ),
      });
      final FirebaseDeliveryClient client = FirebaseDeliveryClient(
        identity: FirebaseTvIdentity(partyId: 'pilot', deviceId: 'tv-pilot'),
        callableInvoker: invoker,
        now: () => DateTime.utc(2026, 10, 29),
      );
      final ClipDescriptor identicalContent = ClipDescriptor(
        id: 'clip-1',
        cameraId: 'CAM-01',
        storageObjectId: 'parties/pilot/old/CAM-01.mp4',
        sha256: hashes['CAM-01']!,
        sizeBytes: 10,
        duration: const Duration(seconds: 2),
        mimeType: 'video/mp4',
      );
      expect(
        await client.refreshUrlFor(channelId: 'main', clip: identicalContent),
        Uri.parse('https://delivery.test/CAM-01.mp4'),
      );

      final ClipDescriptor changedContent = ClipDescriptor(
        id: 'clip-1',
        cameraId: 'CAM-01',
        storageObjectId: 'parties/pilot/old/CAM-01.mp4',
        sha256: 'e' * 64,
        sizeBytes: 10,
        duration: const Duration(seconds: 2),
        mimeType: 'video/mp4',
      );
      await expectLater(
        client.refreshUrlFor(channelId: 'main', clip: changedContent),
        throwsStateError,
      );
    },
  );

  test(
    'ACK response must identify the requested version and completed purge',
    () async {      final Map<String, String> hashes = <String, String>{
        for (final CctvSlot slot in cctvSlots)
          slot.id: String.fromCharCode(96 + slot.index + 1) * 64,
      };
      final List<Object?> responses = <Object?>[
        null,
        <String, Object?>{'manifestVersion': 1, 'purged': true},
        <String, Object?>{'ackId': 'ack', 'purged': true},
        <String, Object?>{
          'ackId': 'ack',
          'manifestVersion': '1',
          'purged': true,
        },
        <String, Object?>{'ackId': 'ack', 'manifestVersion': 2, 'purged': true},
        <String, Object?>{
          'ackId': 'ack',
          'manifestVersion': 1,
          'purged': false,
        },
        <String, Object?>{'ackId': '', 'manifestVersion': 1, 'purged': true},
      ];
      for (final Object? response in responses) {
        await expectLater(
          FirebaseDeliveryClient(
            identity: FirebaseTvIdentity(
              partyId: 'pilot',
              deviceId: 'tv-pilot',
            ),
            callableInvoker: _OneResponseCallable(response),
          ).acknowledge(
            partyId: 'pilot',
            channelId: 'main',
            manifestVersion: 1,
            verifiedClipHashes: hashes,
          ),
          throwsFormatException,
        );
      }

      final FirebaseDeliveryClient success = FirebaseDeliveryClient(
        identity: FirebaseTvIdentity(partyId: 'pilot', deviceId: 'tv-pilot'),
        callableInvoker: _OneResponseCallable(<String, Object?>{
          'ackId': 'ack-1',
          'manifestVersion': 1,
          'purged': true,
        }),
      );
      await success.acknowledge(
        partyId: 'pilot',
        channelId: 'main',
        manifestVersion: 1,
        verifiedClipHashes: hashes,
      );
    },
  );

  test(
    '1/2/4-camera delivery URL and ACK validation through the real client',
    () async {
      for (final int count in <int>[1, 2, 4]) {
        final List<String> cameras = expectedCctvCameraIds(count);
        final Map<String, String> hashes = <String, String>{
          for (final String camera in cameras) camera: 'a' * 64,
        };
        final _FixtureCallable invoker = _FixtureCallable(<String, Object?>{
          'getDeliveryUrls': <String, Object?>{
            'manifestVersion': 3,
            'manifestHash': 'c' * 64,
            'clips': <Map<String, Object?>>[
              for (final String camera in cameras)
                <String, Object?>{
                  'cameraId': camera,
                  'sha256': hashes[camera],
                  'url': 'https://delivery.test/$camera.mp4',
                  'expiresAt': '2030-01-01T00:00:00.000Z',
                },
            ],
          },
          'acknowledgeDelivery': <String, Object?>{
            'ackId': 'backend-ack-$count',
            'manifestVersion': 3,
            'purged': true,
          },
        });
        final FirebaseDeliveryClient client = FirebaseDeliveryClient(
          identity: FirebaseTvIdentity(partyId: 'pilot', deviceId: 'tv-pilot'),
          callableInvoker: invoker,
          now: () => DateTime.utc(2026, 10, 29),
        );
        final FirebaseDeliveryUrls urls = await client.getDeliveryUrls(
          channelId: 'main',
        );
        expect(urls.clips, hasLength(count));
        expect(
          urls.clips.map((clip) => clip.cameraId).toList(),
          cameras,
        );
        // ACK hashes must exactly match the received manifest: the complete
        // received set is ACKed (reduced layouts still ACK everything).
        await client.acknowledge(
          partyId: 'pilot',
          channelId: 'main',
          manifestVersion: 3,
          verifiedClipHashes: hashes,
        );
        expect(invoker.calls.last.$2['clipHashes'], hashes);
      }
    },
  );

  test('delivery and ACK reject unsupported counts, gaps, and extras', () async {
    FirebaseDeliveryClient clientFor(Object? response) => FirebaseDeliveryClient(
      identity: FirebaseTvIdentity(partyId: 'pilot', deviceId: 'tv-pilot'),
      callableInvoker: _OneResponseCallable(response),
      now: () => DateTime.utc(2026, 10, 29),
    );
    Map<String, Object?> clip(String camera) => <String, Object?>{
      'cameraId': camera,
      'sha256': 'a' * 64,
      'url': 'https://delivery.test/$camera.mp4',
      'expiresAt': '2030-01-01T00:00:00.000Z',
    };
    // 3 clips: unsupported count.
    await expectLater(
      clientFor(<String, Object?>{
        'manifestVersion': 1,
        'manifestHash': 'c' * 64,
        'clips': [clip('CAM-01'), clip('CAM-02'), clip('CAM-03')],
      }).getDeliveryUrls(channelId: 'main'),
      throwsFormatException,
    );
    // Gap: {CAM-01, CAM-03} is not the first-2 prefix.
    await expectLater(
      clientFor(<String, Object?>{
        'manifestVersion': 1,
        'manifestHash': 'c' * 64,
        'clips': [clip('CAM-01'), clip('CAM-03')],
      }).getDeliveryUrls(channelId: 'main'),
      throwsFormatException,
    );
    // Duplicate camera.
    await expectLater(
      clientFor(<String, Object?>{
        'manifestVersion': 1,
        'manifestHash': 'c' * 64,
        'clips': [clip('CAM-01'), clip('CAM-01')],
      }).getDeliveryUrls(channelId: 'main'),
      throwsFormatException,
    );
    // ACK with an extra hash beyond the 2-clip prefix is rejected client-side.
    await expectLater(
      clientFor(<String, Object?>{
        'ackId': 'ack',
        'manifestVersion': 1,
        'purged': true,
      }).acknowledge(
        partyId: 'pilot',
        channelId: 'main',
        manifestVersion: 1,
        verifiedClipHashes: <String, String>{
          'CAM-01': 'a' * 64,
          'CAM-02': 'a' * 64,
          'CAM-03': 'a' * 64,
        },
      ),
      throwsArgumentError,
    );
    // ACK with a gapped 2-set is rejected client-side.
    await expectLater(
      clientFor(<String, Object?>{
        'ackId': 'ack',
        'manifestVersion': 1,
        'purged': true,
      }).acknowledge(
        partyId: 'pilot',
        channelId: 'main',
        manifestVersion: 1,
        verifiedClipHashes: <String, String>{
          'CAM-01': 'a' * 64,
          'CAM-03': 'a' * 64,
        },
      ),
      throwsArgumentError,
    );
  });
}

final class _OneResponseCallable implements FirebaseCallableInvoker {
  _OneResponseCallable(this.response);

  final Object? response;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async =>
      response;
}
