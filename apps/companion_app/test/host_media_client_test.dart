import 'dart:async';

import 'package:companion_app/src/data/host_media_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_firestore/infra_firestore.dart'
    show ManifestTransportException;

/// Backend-faithful fake: envelopes mirror
/// backend/functions/src/contracts.ts (list/generate/preview/delete) and the
/// host_media.ts service paths (scope echo, per-seed deletion, signed
/// preview URLs that are never persisted).
class FakeHostMediaInvoker implements HostMediaCallableInvoker {
  final List<String> names = <String>[];
  final List<Map<String, Object?>> payloads = <Map<String, Object?>>[];
  final List<HostSeedVideo> seeds = <HostSeedVideo>[];
  Object? failure;
  Object? nextResponse;
  int generates = 0;

  Map<String, Object?> seedJson(HostSeedVideo seed) => <String, Object?>{
    'seedId': seed.seedId,
    'partyId': seed.partyId,
    'channelId': seed.channelId,
    'status': seed.status,
    'jobId': seed.jobId,
    'createdAt': seed.createdAt,
    'expiresAt': seed.expiresAt,
    'previewAvailable': seed.previewAvailable,
    'cameraIds': seed.cameraIds,
  };

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    names.add(name);
    payloads.add(Map<String, Object?>.of(payload));
    final Object? error = failure;
    if (error != null) throw error;
    final Object? override = nextResponse;
    if (override != null) {
      nextResponse = null;
      return override;
    }
    switch (name) {
      case kListHostVideos:
        return <String, Object?>{
          'videos': <Object?>[for (final s in seeds) seedJson(s)],
        };
      case kGenerateHostVideo:
        generates++;
        return <String, Object?>{
          'seedId': payload['seedId'],
          'jobId': 'hv-${payload['seedId']}',
          'state': 'queued',
          'created': generates == 1,
        };
      case kGetHostVideoPreview:
        final String seedId = payload['seedId'] as String;
        return <String, Object?>{
          'seedId': seedId,
          'expiresAt': '2030-01-01T00:00:00.000Z',
          'clips': <Object?>[
            for (final camera in ['CAM-01', 'CAM-02', 'CAM-03', 'CAM-04'])
              <String, Object?>{
                'cameraId': camera,
                'sha256': List.filled(64, 'a').join(),
                'url': 'https://preview.example/$seedId/$camera.mp4',
                'expiresAt': '2030-01-01T00:00:00.000Z',
              },
          ],
        };
      case kDeleteHostVideo:
        final List<String> ids = <String>[
          for (final Object? id in payload['seedIds'] as List) id.toString(),
        ];
        seeds.removeWhere((s) => ids.contains(s.seedId));
        return <String, Object?>{
          'deletedSeedIds': ids,
          'deletedObjects': <String>[
            for (final id in ids) 'parties/party-1/hostPreviews/$id/CAM-01.mp4',
          ],
          'revokedManifest': true,
        };
    }
    throw StateError('unexpected callable $name');
  }
}

HostSeedVideo seed(String id, String status) => HostSeedVideo(
  seedId: id,
  partyId: 'party-1',
  channelId: 'cctv',
  status: status,
  jobId: 'hv-$id',
  createdAt: '2026-10-29T14:00:00.000Z',
  expiresAt: '2030-01-01T00:00:00.000Z',
  previewAvailable: status == 'ready',
  cameraIds: const <String>['CAM-01', 'CAM-02', 'CAM-03', 'CAM-04'],
);

void main() {
  test('list returns scoped seed entries across lifecycle states', () async {
    final invoker = FakeHostMediaInvoker()
      ..seeds.addAll(<HostSeedVideo>[
        seed('a', 'queued'),
        seed('b', 'running'),
        seed('c', 'ready'),
        seed('d', 'failed'),
        seed('e', 'deleted'),
      ]);
    final videos = await HostMediaClient(invoker: invoker).listVideos(
      partyId: 'party-1',
      deviceId: 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      channelId: 'cctv',
    );
    expect(invoker.names, <String>[kListHostVideos]);
    expect(invoker.payloads.single, containsPair('channelId', 'cctv'));
    expect(videos.map((v) => '${v.seedId}:${v.status}'), <String>[
      'a:queued',
      'b:running',
      'c:ready',
      'd:failed',
      'e:deleted',
    ]);
    expect(videos[2].previewAvailable, isTrue);
  });

  test(
    'generate enqueues the fixed preset and rejects other presets',
    () async {
      final invoker = FakeHostMediaInvoker();
      final client = HostMediaClient(invoker: invoker);
      final result = await client.generateVideo(
        partyId: 'party-1',
        deviceId: 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        channelId: 'cctv',
        seedId: 'catalog-1',
        idempotencyKey: 'idem-1',
      );
      expect(result['seedId'], 'catalog-1');
      expect(result['jobId'], 'hv-catalog-1');
      expect(invoker.payloads.single['presetId'], kCheapDemoPresetId);
      await expectLater(
        client.generateVideo(
          partyId: 'party-1',
          deviceId: 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          channelId: 'cctv',
          seedId: 'catalog-2',
          idempotencyKey: 'idem-2',
          presetId: 'ultra_cinema',
        ),
        throwsArgumentError,
      );
      expect(invoker.generates, 1);
    },
  );

  test('preview returns fresh signed clips with https URLs', () async {
    final invoker = FakeHostMediaInvoker();
    final preview = await HostMediaClient(invoker: invoker).getPreview(
      partyId: 'party-1',
      deviceId: 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      channelId: 'cctv',
      seedId: 'catalog-1',
    );
    expect(preview.seedId, 'catalog-1');
    expect(preview.clips, hasLength(4));
    expect(preview.clips.map((c) => c.cameraId), <String>[
      'CAM-01',
      'CAM-02',
      'CAM-03',
      'CAM-04',
    ]);
    for (final clip in preview.clips) {
      expect(clip.url.scheme, 'https');
    }
  });

  test('delete reconciles per selected seed id', () async {
    final invoker = FakeHostMediaInvoker()
      ..seeds.addAll(<HostSeedVideo>[seed('a', 'ready'), seed('b', 'ready')]);
    final client = HostMediaClient(invoker: invoker);
    final result = await client.deleteVideos(
      partyId: 'party-1',
      deviceId: 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      channelId: 'cctv',
      seedIds: const <String>['a'],
    );
    expect(result['deletedSeedIds'], <String>['a']);
    expect(result['revokedManifest'], isTrue);
    expect(
      (await client.listVideos(
        partyId: 'party-1',
        deviceId: 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        channelId: 'cctv',
      )).map((v) => v.seedId),
      <String>['b'],
    );
  });

  test('rejects cross-party entries and malformed shapes', () async {
    final invoker = FakeHostMediaInvoker();
    final client = HostMediaClient(invoker: invoker);
    invoker.seeds.add(
      const HostSeedVideo(
        seedId: 'x',
        partyId: 'other-party',
        channelId: 'cctv',
        status: 'ready',
        jobId: 'hv-x',
        createdAt: '2026-10-29T14:00:00.000Z',
        expiresAt: '2030-01-01T00:00:00.000Z',
        previewAvailable: true,
        cameraIds: <String>['CAM-01'],
      ),
    );
    await expectLater(
      client.listVideos(
        partyId: 'party-1',
        deviceId: 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        channelId: 'cctv',
      ),
      throwsFormatException,
    );
    invoker.seeds.clear();
    invoker.nextResponse = <String, Object?>{'unexpected': 'shape'};
    await expectLater(
      client.listVideos(
        partyId: 'party-1',
        deviceId: 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        channelId: 'cctv',
      ),
      throwsFormatException,
    );
  });

  test('bounds a callable that never completes', () async {
    final client = HostMediaClient(
      invoker: _PendingInvoker(),
      timeout: const Duration(milliseconds: 5),
    );
    await expectLater(
      client.listVideos(
        partyId: 'party-1',
        deviceId: 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        channelId: 'cctv',
      ),
      throwsA(isA<ManifestTransportException>()),
    );
  });
}

final class _PendingInvoker implements HostMediaCallableInvoker {
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) =>
      Completer<Object?>().future;
}
