/// Verified media cache port (Technical Design v1.0, section 8).
library;

import 'package:core_playlist/core_playlist.dart';

/// Raw downloaded bytes awaiting verification/commit.
final class DownloadedMedia {
  /// Clip this payload belongs to.
  final String clipId;

  /// Raw bytes.
  final List<int> bytes;

  /// Expected hex sha256 of [bytes].
  final String sha256;

  DownloadedMedia({
    required String clipId,
    required List<int> bytes,
    required String sha256,
  }) : clipId = _requireNonEmpty(clipId, 'clipId'),
       bytes = List<int>.unmodifiable(bytes),
       sha256 = _requireSha256(sha256);

  /// Number of downloaded bytes.
  int get byteLength => bytes.length;

  static String _requireNonEmpty(String value, String name) {
    if (value.trim().isEmpty) {
      throw ArgumentError.value(value, name, '$name must be non-empty');
    }
    return value;
  }

  static String _requireSha256(String value) {
    if (!isValidSha256Hex(value)) {
      throw ArgumentError.value(value, 'sha256', 'expected 64 hex characters');
    }
    return value;
  }

  @override
  String toString() => 'DownloadedMedia($clipId, $byteLength bytes)';
}

/// Verified, locally referenced media.
final class CachedMedia {
  /// Clip this entry belongs to.
  final String clipId;

  /// Opaque local reference (path, key, or URI — never interpreted here).
  final String localRef;

  /// Verified hex sha256.
  final String sha256;

  const CachedMedia({
    required this.clipId,
    required this.localRef,
    required this.sha256,
  }) : assert(clipId != '', 'CachedMedia.clipId must be non-empty'),
       assert(localRef != '', 'CachedMedia.localRef must be non-empty'),
       assert(sha256.length == 64, 'CachedMedia.sha256 must be 64 hex chars');

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is CachedMedia &&
          other.clipId == clipId &&
          other.localRef == localRef &&
          other.sha256 == sha256);

  @override
  int get hashCode => Object.hash(clipId, localRef, sha256);

  @override
  String toString() => 'CachedMedia($clipId -> $localRef)';
}

/// Cache port: lookup of verified media, commit of downloads, expiry.
///
/// Implementations own byte-level verification; callers only see entries
/// whose sha256 matched the clip descriptor they asked for.
abstract class CacheStore {
  /// Returns verified cached media for [clip], or null on miss/mismatch.
  Future<CachedMedia?> findVerified(ClipDescriptor clip);

  /// Verifies and commits [media]; returns the cached entry.
  Future<CachedMedia> commit(DownloadedMedia media);

  /// Deletes expired entries; returns the number removed.
  Future<int> deleteExpired();
}
