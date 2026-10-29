import 'dart:io';

import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_signed_urls/infra_signed_urls.dart';

import 'support/https_fixture_server.dart';

ClipDescriptor _clip(List<int> bytes, {String? sha256}) => ClipDescriptor(
  id: 'clip-1',
  cameraId: 'CAM-01',
  storageObjectId: 'delivery/CAM-01.mp4',
  sha256: sha256 ?? sha256Hex(bytes),
  sizeBytes: bytes.length,
  duration: const Duration(seconds: 2),
  mimeType: 'video/mp4',
);

void main() {
  test(
    'streams an HTTPS response and verifies exact bytes and SHA-256',
    () async {
      final List<int> bytes = List<int>.generate(512, (int i) => i % 256);
      final Directory staging = await Directory.systemTemp.createTemp(
        'media-stage-',
      );
      final HttpsFixtureServer server = await HttpsFixtureServer.start(
        responses: <String, HttpsFixtureResponse>{
          '/clip': HttpsFixtureResponse(statusCode: 200, body: bytes),
        },
      );
      final HttpClient httpClient = testHttpClient();
      try {
        final DownloadedMedia result = await HttpsMediaDownloader(
          tempDirectory: staging,
          httpClient: httpClient,
        ).downloadAndVerify(_clip(bytes), server.uriFor('/clip'));

        expect(result.bytes, bytes);
        expect(result.byteLength, bytes.length);
        expect(result.sha256, sha256Hex(bytes));
        expect(await staging.list().toList(), isEmpty);
      } finally {
        httpClient.close(force: true);
        await server.close();
        await staging.delete(recursive: true);
      }
    },
  );

  test(
    'discards a response that ends before its declared byte count',
    () async {
      final List<int> bytes = <int>[4, 8, 15, 16];
      final Directory staging = await Directory.systemTemp.createTemp(
        'media-partial-',
      );
      final HttpsFixtureServer server = await HttpsFixtureServer.start(
        responses: <String, HttpsFixtureResponse>{
          '/partial': HttpsFixtureResponse(
            statusCode: 200,
            body: bytes,
            declaredLength: bytes.length + 20,
          ),
        },
      );
      final HttpClient httpClient = testHttpClient();
      try {
        await expectLater(
          HttpsMediaDownloader(
            tempDirectory: staging,
            httpClient: httpClient,
          ).downloadAndVerify(_clip(bytes), server.uriFor('/partial')),
          throwsA(anyOf(isA<HttpException>(), isA<SocketException>())),
        );
        expect(await staging.list().toList(), isEmpty);
      } finally {
        httpClient.close(force: true);
        await server.close();
        await staging.delete(recursive: true);
      }
    },
  );

  test('rejects corrupt bytes even when the byte count matches', () async {
    final List<int> expected = <int>[0, 1, 2, 3, 4];
    final List<int> corrupt = <int>[0, 1, 2, 9, 4];
    final HttpsFixtureServer server = await HttpsFixtureServer.start(
      responses: <String, HttpsFixtureResponse>{
        '/corrupt': HttpsFixtureResponse(statusCode: 200, body: corrupt),
      },
    );
    final HttpClient httpClient = testHttpClient();
    try {
      await expectLater(
        HttpsMediaDownloader(httpClient: httpClient)
            .downloadAndVerify(_clip(expected), server.uriFor('/corrupt')),
        throwsA(isA<FormatException>()),
      );
    } finally {
      httpClient.close(force: true);
      await server.close();
    }
  });

  test('refreshes one expired URL and retries with the replacement', () async {
    final List<int> bytes = <int>[6, 2, 6, 4];
    final List<String> requests = <String>[];
    final HttpsFixtureServer server = await HttpsFixtureServer.start(
      onRequest: requests.add,
      responses: <String, HttpsFixtureResponse>{
        '/expired': const HttpsFixtureResponse(statusCode: 403),
        '/fresh': HttpsFixtureResponse(statusCode: 200, body: bytes),
      },
    );
    final HttpClient httpClient = testHttpClient();
    try {
      final DownloadedMedia result = await HttpsMediaDownloader(
        httpClient: httpClient,
        expiredUrlRefresher: (ClipDescriptor clip, Uri _) async =>
            server.uriFor('/fresh'),
      ).downloadAndVerify(_clip(bytes), server.uriFor('/expired'));

      expect(result.sha256, sha256Hex(bytes));
      expect(requests, ['/expired', '/fresh']);
    } finally {
      httpClient.close(force: true);
      await server.close();
    }
  });

  test('never opens more than two HTTP requests at once', () async {
    final List<int> bytes = <int>[1, 2, 3];
    var active = 0;
    var peak = 0;
    final HttpsFixtureServer server = await HttpsFixtureServer.start(
      onRequest: (String _) {
        active++;
        if (active > peak) peak = active;
      },
      onResponse: (String _) => active--,
      responses: <String, HttpsFixtureResponse>{
        '/slow': HttpsFixtureResponse(
          statusCode: 200,
          body: bytes,
          delay: const Duration(milliseconds: 80),
        ),
      },
    );
    final HttpClient httpClient = testHttpClient();
    try {
      final HttpsMediaDownloader downloader = HttpsMediaDownloader(
        httpClient: httpClient,
      );
      await Future.wait(<Future<DownloadedMedia>>[
        for (var i = 0; i < 4; i++)
          downloader.downloadAndVerify(_clip(bytes), server.uriFor('/slow')),
      ]);
      expect(peak, 2);
    } finally {
      httpClient.close(force: true);
      await server.close();
    }
  });

  test(
    'downloadAndCommit returns a cache entry committed through CacheStore',
    () async {
      final List<int> bytes = <int>[10, 20, 30, 40];
      final Directory cacheRoot = await Directory.systemTemp.createTemp(
        'media-cache-',
      );
      final HttpsFixtureServer server = await HttpsFixtureServer.start(
        responses: <String, HttpsFixtureResponse>{
          '/commit': HttpsFixtureResponse(statusCode: 200, body: bytes),
        },
      );
      final HttpClient httpClient = testHttpClient();
      try {
        final FileCacheStore cache = FileCacheStore(cacheRoot);
        final ClipDescriptor clip = _clip(bytes);
        final CachedMedia result =
            await HttpsMediaDownloader(httpClient: httpClient)
                .downloadAndCommit(
                  clip: clip,
                  source: server.uriFor('/commit'),
                  cacheStore: cache,
                );

        expect(result.clipId, clip.id);
        expect(await File(result.localRef).readAsBytes(), bytes);
        expect(await cache.findVerified(clip), result);
      } finally {
        httpClient.close(force: true);
        await server.close();
        await cacheRoot.delete(recursive: true);
      }
    },
  );
}
