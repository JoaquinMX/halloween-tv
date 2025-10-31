import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:core_cache/core_cache.dart';

void main() {
  test('LocalFileCache stores and retrieves file with checksum', () async {
    final tempDir = await Directory.systemTemp.createTemp('cache_test');
    final cache = LocalFileCache(root: tempDir);
    final data = utf8.encode('spooky');
    final checksum = sha256.convert(data).toString();

    final fileRef = await cache.put('clip.mp4', Stream<List<int>>.value(data), checksum: checksum);
    expect(await fileRef.file.exists(), isTrue);

    final fetched = await cache.get('clip.mp4');
    expect(fetched, isNotNull);
    expect(fetched!.checksum, checksum);
  });
}
