import 'dart:async';
import 'dart:typed_data';

import 'package:core_cache/core_cache.dart';

/// Fake media fetcher that simply writes provided buffers.
class FakeMediaFetchPort implements MediaFetchPort {
  FakeMediaFetchPort(this.cachePort);

  final CachePort cachePort;
  final Map<String, Uint8List> _files = <String, Uint8List>{};

  void seed(String key, Uint8List bytes) {
    _files[key] = bytes;
  }

  @override
  Future<bool> exists(String localKey, {String? checksum}) async => _files.containsKey(localKey);

  @override
  Future<FileRef> prefetch(ClipRef ref, {required String checksum}) {
    final Uint8List? data = _files[ref.localKey];
    if (data == null) {
      throw StateError('No seeded data for ${ref.localKey}');
    }
    return cachePort.put(ref.localKey, Stream<List<int>>.value(data), checksum: checksum);
  }
}
