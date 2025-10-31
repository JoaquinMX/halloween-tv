import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'cache_port.dart';
import 'file_ref.dart';

/// Default local file cache implementation storing clips on disk.
class LocalFileCache implements CachePort {
  LocalFileCache({Directory? root, this.verifyChecksums = true})
      : _rootFuture = root != null ? Future<Directory>.value(root) : _resolveRoot();

  static Future<Directory> _resolveRoot() async {
    final Directory base = await getApplicationSupportDirectory();
    final Directory cacheDir = Directory(p.join(base.path, 'halloween_tv_cache'));
    if (!cacheDir.existsSync()) {
      cacheDir.createSync(recursive: true);
    }
    return cacheDir;
  }

  final Future<Directory> _rootFuture;
  final bool verifyChecksums;

  @override
  Future<FileRef?> get(String localKey) async {
    final Directory root = await _rootFuture;
    final File file = File(p.join(root.path, localKey));
    if (!await file.exists()) {
      return null;
    }
    final String checksum = await _computeChecksum(file.openRead());
    return FileRef(file: file, checksum: checksum);
  }

  @override
  Future<FileRef> put(String localKey, Stream<List<int>> bytes, {required String checksum}) async {
    final Directory root = await _rootFuture;
    final File file = File(p.join(root.path, localKey));
    if (!await file.parent.exists()) {
      await file.parent.create(recursive: true);
    }

    final IOSink sink = file.openWrite(mode: FileMode.writeOnly);
    final AccumulatorSink<Digest> digestSink = AccumulatorSink<Digest>();
    final ByteConversionSink byteSink = sha256.startChunkedConversion(digestSink);
    await for (final List<int> chunk in bytes) {
      sink.add(chunk);
      byteSink.add(chunk);
    }
    await sink.close();
    byteSink.close();
    final String computed = digestSink.events.single.toString();

    if (verifyChecksums && !constantTimeEquals(computed, checksum)) {
      await file.delete().catchError((_) {});
      throw StateError('Checksum mismatch for $localKey');
    }

    return FileRef(file: file, checksum: computed);
  }

  Future<String> _computeChecksum(Stream<List<int>> source) async {
    final AccumulatorSink<Digest> digestSink = AccumulatorSink<Digest>();
    final ByteConversionSink byteSink = sha256.startChunkedConversion(digestSink);
    await for (final List<int> chunk in source) {
      byteSink.add(chunk);
    }
    byteSink.close();
    return digestSink.events.single.toString();
  }
}
