import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:core_cache/core_cache.dart';

/// In-memory cache port for tests.
class FakeCachePort implements CachePort {
  FakeCachePort();

  final Map<String, Uint8List> _files = <String, Uint8List>{};

  @override
  Future<FileRef?> get(String localKey) async {
    final Uint8List? bytes = _files[localKey];
    if (bytes == null) {
      return null;
    }
    final File temp = await File('${Directory.systemTemp.path}/$localKey').create(recursive: true);
    await temp.writeAsBytes(bytes, flush: true);
    final String checksum = sha256.convert(bytes).toString();
    return FileRef(file: temp, checksum: checksum);
  }

  @override
  Future<FileRef> put(String localKey, Stream<List<int>> bytes, {required String checksum}) async {
    final List<int> buffer = <int>[];
    await for (final List<int> chunk in bytes) {
      buffer.addAll(chunk);
    }
    final Uint8List data = Uint8List.fromList(buffer);
    final String computed = sha256.convert(data).toString();
    if (computed != checksum) {
      throw StateError('Checksum mismatch in fake cache');
    }
    _files[localKey] = data;
    final File temp = await File('${Directory.systemTemp.path}/$localKey').create(recursive: true);
    await temp.writeAsBytes(data, flush: true);
    return FileRef(file: temp, checksum: computed);
  }
}
