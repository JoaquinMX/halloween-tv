import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:core_cache/core_cache.dart';
import 'package:infra_signed_urls/infra_signed_urls.dart';
import 'package:retry/retry.dart';
import 'package:test/test.dart';

class _MemoryCachePort implements CachePort {
  _MemoryCachePort() : _tempDir = Directory.systemTemp.createTempSync('cache_test');

  final Directory _tempDir;
  final Map<String, Uint8List> _store = <String, Uint8List>{};

  @override
  Future<FileRef?> get(String localKey) async {
    final Uint8List? data = _store[localKey];
    if (data == null) {
      return null;
    }
    final file = File('${_tempDir.path}/$localKey')..createSync(recursive: true);
    await file.writeAsBytes(data, flush: true);
    return FileRef(file: file, checksum: _checksum(data));
  }

  @override
  Future<FileRef> put(String localKey, Stream<List<int>> bytes, {required String checksum}) async {
    final List<int> buffer = <int>[];
    await for (final chunk in bytes) {
      buffer.addAll(chunk);
    }
    final data = Uint8List.fromList(buffer);
    _store[localKey] = data;
    final file = File('${_tempDir.path}/$localKey')..createSync(recursive: true);
    await file.writeAsBytes(data, flush: true);
    return FileRef(file: file, checksum: checksum);
  }

  String _checksum(Uint8List data) => data.fold<int>(0, (int a, int b) => a + b).toString();
}

void main() {
  test('prefetch streams bytes to cache', () async {
    final cache = _MemoryCachePort();
    final client = MockClient((http.Request request) async {
      final stream = Stream<List<int>>.value(<int>[1, 2, 3, 4]);
      return http.StreamedResponse(stream, 200, contentLength: 4);
    });
    final fetcher = SignedUrlFetcher(cachePort: cache, client: client, retryOptions: const RetryOptions(maxAttempts: 1));

    final file = await fetcher.prefetch(
      const ClipRef(localKey: 'clip.mp4', signedUrl: 'https://example.com', sizeBytes: 4),
      checksum: '10',
    );

    expect(await file.file.length(), 4);
  });
}
