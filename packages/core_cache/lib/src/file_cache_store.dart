/// `dart:io` implementation of the cache and manifest-index ports.
library;

import 'dart:convert';
import 'dart:io';

import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';

/// File-backed [CacheStore] that verifies bytes on both read and write.
///
/// References returned in [CachedMedia.localRef] are opaque absolute paths.
/// The cache only publishes those references after a `.part` file has been
/// flushed, re-read, verified, and atomically renamed into place.
final class FileCacheStore implements CacheStore {
  /// Creates a cache rooted under [root].
  FileCacheStore(
    this.root, {
    this.maxAge = const Duration(days: 30),
    Directory? indexRoot,
    DateTime Function()? now,
  }) : indexRoot = indexRoot ?? Directory(_join(root.path, 'indexes')),
       _now = now ?? DateTime.now {
    if (maxAge.isNegative) {
      throw ArgumentError.value(maxAge, 'maxAge', 'must not be negative');
    }
  }

  /// Cache directory.
  final Directory root;

  /// Maximum age of unreferenced media and abandoned partial files.
  final Duration maxAge;

  /// Directory containing indexes that protect last-known-good media.
  final Directory indexRoot;

  final DateTime Function() _now;

  Directory get _mediaDirectory => Directory(_join(root.path, 'media'));

  @override
  Future<CachedMedia?> findVerified(ClipDescriptor clip) async {
    final File file = _mediaFile(clip.sha256.toLowerCase());
    if (!await file.exists()) {
      return null;
    }
    try {
      final List<int> bytes = await file.readAsBytes();
      if (bytes.length != clip.sizeBytes ||
          sha256Hex(bytes) != clip.sha256.toLowerCase()) {
        return null;
      }
      return CachedMedia(
        clipId: clip.id,
        localRef: file.absolute.path,
        sha256: clip.sha256.toLowerCase(),
      );
    } on FileSystemException {
      return null;
    }
  }

  @override
  Future<CachedMedia> commit(DownloadedMedia media) async {
    if (media.bytes.isEmpty) {
      throw ArgumentError.value(
        media.byteLength,
        'media.bytes',
        'must not be empty',
      );
    }
    final String digest = sha256Hex(media.bytes);
    if (digest != media.sha256.toLowerCase()) {
      throw const FormatException(
        'downloaded media digest does not match its bytes',
      );
    }
    await _mediaDirectory.create(recursive: true);
    final File destination = _mediaFile(digest);
    if (await destination.exists()) {
      final List<int> current = await destination.readAsBytes();
      if (sha256Hex(current) == digest && current.length == media.byteLength) {
        return CachedMedia(
          clipId: media.clipId,
          localRef: destination.absolute.path,
          sha256: digest,
        );
      }
    }

    final File partial = File(
      '${destination.path}.${_now().microsecondsSinceEpoch}.part',
    );
    try {
      await partial.writeAsBytes(media.bytes, flush: true);
      final List<int> persisted = await partial.readAsBytes();
      if (persisted.length != media.byteLength ||
          sha256Hex(persisted) != digest) {
        throw const FileSystemException(
          'partial cache file failed verification',
        );
      }
      await partial.rename(destination.path);
      return CachedMedia(
        clipId: media.clipId,
        localRef: destination.absolute.path,
        sha256: digest,
      );
    } finally {
      if (await partial.exists()) {
        await partial.delete();
      }
    }
  }

  @override
  Future<int> deleteExpired() async {
    if (!await _mediaDirectory.exists()) {
      return 0;
    }
    var removed = 0;
    final DateTime cutoff = _now().subtract(maxAge);
    final Set<String>? protectedRefs = await _readProtectedRefs();
    if (protectedRefs == null) {
      // A malformed index must not cause a local last-known-good clip to be
      // evicted. A later cleanup can retry after the index is repaired.
      return 0;
    }
    await for (final FileSystemEntity entity in _mediaDirectory.list()) {
      if (entity is! File) {
        continue;
      }
      if (!entity.path.endsWith('.media') && !entity.path.endsWith('.part')) {
        continue;
      }
      try {
        final String absolutePath = entity.absolute.path;
        if (entity.path.endsWith('.media') &&
            protectedRefs.contains(absolutePath)) {
          continue;
        }
        if ((await entity.lastModified()).isBefore(cutoff)) {
          await entity.delete();
          removed++;
        }
      } on FileSystemException {
        // Another cache operation may have removed the file concurrently.
      }
    }
    return removed;
  }

  Future<Set<String>?> _readProtectedRefs() async {
    if (!await indexRoot.exists()) {
      return <String>{};
    }
    final Set<String> refs = <String>{};
    try {
      await for (final FileSystemEntity entity in indexRoot.list()) {
        if (entity is! File || !entity.path.endsWith('.index.json')) {
          continue;
        }
        final Object? decoded = jsonDecode(await entity.readAsString());
        if (decoded is! Map || decoded['clipHashToLocalRef'] is! Map) {
          return null;
        }
        final Map<Object?, Object?> rawRefs =
            decoded['clipHashToLocalRef']! as Map<Object?, Object?>;
        for (final Object? value in rawRefs.values) {
          if (value is! String || value.trim().isEmpty) {
            return null;
          }
          refs.add(File(value).absolute.path);
        }
      }
      return refs;
    } on Object {
      return null;
    }
  }

  File _mediaFile(String digest) {
    // Content-addressed storage lets identical clips share one opaque ref,
    // which matches the durable SHA-256 -> localRef index contract.
    return File(_join(_mediaDirectory.path, '$digest.media'));
  }
}

/// File-backed [ManifestIndexStore] with a flushed temp file and atomic rename.
final class FileManifestIndexStore implements ManifestIndexStore {
  /// Creates an index store rooted under [root].
  FileManifestIndexStore(this.root, {DateTime Function()? now})
    : _now = now ?? DateTime.now;

  /// Index directory.
  final Directory root;

  final DateTime Function() _now;

  @override
  Future<CommittedManifestIndex?> readCommitted({
    required String partyId,
    required String channelId,
  }) async {
    final File file = _indexFile(partyId, channelId);
    if (!await file.exists()) {
      return null;
    }
    final Object? decoded = jsonDecode(await file.readAsString());
    if (decoded is! Map) {
      throw const FormatException('manifest index must be a JSON object');
    }
    final Map<String, Object?> json = Map<String, Object?>.from(decoded);
    final Object? rawManifest = json['manifest'];
    final Object? rawRefs = json['clipHashToLocalRef'];
    if (rawManifest is! Map || rawRefs is! Map) {
      throw const FormatException('manifest index is missing required fields');
    }
    final PlaybackManifest manifest = parseManifest(
      Map<String, Object?>.from(rawManifest),
    );
    if (manifest.partyId != partyId || manifest.channelId != channelId) {
      throw const FormatException(
        'manifest index scope does not match its key',
      );
    }
    final Map<String, String> refs = <String, String>{};
    for (final MapEntry<Object?, Object?> entry in rawRefs.entries) {
      if (entry.key is! String || entry.value is! String) {
        throw const FormatException('manifest index refs must map strings');
      }
      refs[entry.key! as String] = entry.value! as String;
    }
    return CommittedManifestIndex(manifest: manifest, clipHashToLocalRef: refs);
  }

  @override
  Future<void> writeAtomically(CommittedManifestIndex index) async {
    await root.create(recursive: true);
    final File destination = _indexFile(
      index.manifest.partyId,
      index.manifest.channelId,
    );
    final File partial = File(
      '${destination.path}.${_now().microsecondsSinceEpoch}.part',
    );
    final Map<String, Object?> payload = <String, Object?>{
      'manifest': index.manifest.toJson(),
      'clipHashToLocalRef': index.clipHashToLocalRef,
    };
    try {
      await partial.writeAsString(jsonEncode(payload), flush: true);
      // Parse the staged bytes before replacing the last-known-good index.
      final Object? check = jsonDecode(await partial.readAsString());
      if (check is! Map ||
          check['manifest'] is! Map ||
          check['clipHashToLocalRef'] is! Map) {
        throw const FileSystemException('staged manifest index is invalid');
      }
      await partial.rename(destination.path);
    } finally {
      if (await partial.exists()) {
        await partial.delete();
      }
    }
  }

  File _indexFile(String partyId, String channelId) {
    final String scope = sha256Hex(utf8.encode('$partyId\u0000$channelId'));
    return File(_join(root.path, '$scope.index.json'));
  }
}

String _join(String parent, String child) =>
    parent.endsWith(Platform.pathSeparator)
    ? '$parent$child'
    : '$parent${Platform.pathSeparator}$child';
