/// Verified media cache port (Technical Design v1.0, section 8).
library;

import 'package:core_playlist/core_playlist.dart';

/// Computes the lowercase hex SHA-256 digest of [bytes].
///
/// Pure-Dart implementation so `core_cache` (and the TV boot path, which
/// reuses this helper to verify bundled asset bytes) does not need a
/// third-party crypto dependency.
String sha256Hex(List<int> bytes) => _Sha256.hex(bytes);

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

  /// Builds media from raw [bytes], computing the SHA-256 digest itself.
  ///
  /// Callers cannot supply a mismatched digest through this factory: the
  /// stored [sha256] is always `sha256Hex(bytes)`. Tampering is detected
  /// by comparing against the manifest descriptor (see `matchesClip`).
  factory DownloadedMedia.fromBytes({
    required String clipId,
    required List<int> bytes,
  }) {
    final String id = _requireNonEmpty(clipId, 'clipId');
    final List<int> frozen = List<int>.unmodifiable(bytes);
    return DownloadedMedia(
      clipId: id,
      bytes: frozen,
      sha256: sha256Hex(frozen),
    );
  }

  /// Number of downloaded bytes.
  int get byteLength => bytes.length;

  /// True when these bytes match [clip]'s declared digest and size.
  bool matchesClip(ClipDescriptor clip) =>
      bytes.length == clip.sizeBytes &&
      sha256.toLowerCase() == clip.sha256.toLowerCase();

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
///
/// Phase-2 note (full CacheStore adapter, not yet wired into boot):
/// the production adapter will implement this port on top of the on-disk
/// media cache — `findVerified` returns the entry only when the stored
/// bytes' SHA-256 still matches the requested [ClipDescriptor.sha256]
/// (re-hash on hit, miss on mismatch), `commit` persists
/// [DownloadedMedia.bytes] then re-reads and re-hashes before returning
/// the [CachedMedia] entry, and `deleteExpired` evicts entries whose
/// manifest version is superseded. Until that adapter lands, the boot
/// path verifies the bundled offline assets directly with [sha256Hex]
/// (zero network, fail closed to unavailable on any mismatch).
abstract class CacheStore {
  /// Returns verified cached media for [clip], or null on miss/mismatch.
  Future<CachedMedia?> findVerified(ClipDescriptor clip);

  /// Verifies and commits [media]; returns the cached entry.
  Future<CachedMedia> commit(DownloadedMedia media);

  /// Deletes expired entries; returns the number removed.
  Future<int> deleteExpired();
}

// --- Minimal SHA-256 (FIPS 180-4), pure Dart, no third-party dep. ---

final class _Sha256 {
  static const List<int> _k = <int>[
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  static String hex(List<int> bytes) {
    var h0 = 0x6a09e667;
    var h1 = 0xbb67ae85;
    var h2 = 0x3c6ef372;
    var h3 = 0xa54ff53a;
    var h4 = 0x510e527f;
    var h5 = 0x9b05688c;
    var h6 = 0x1f83d9ab;
    var h7 = 0x5be0cd19;

    final int bitLen = bytes.length * 8;
    final List<int> padded = List<int>.from(bytes)..add(0x80);
    while (padded.length % 64 != 56) {
      padded.add(0);
    }
    for (var i = 7; i >= 0; i--) {
      padded.add((bitLen >> (i * 8)) & 0xff);
    }

    final List<int> w = List<int>.filled(64, 0);
    for (var off = 0; off < padded.length; off += 64) {
      for (var i = 0; i < 16; i++) {
        w[i] =
            ((padded[off + i * 4] << 24) |
                (padded[off + i * 4 + 1] << 16) |
                (padded[off + i * 4 + 2] << 8) |
                padded[off + i * 4 + 3]) &
            0xffffffff;
      }
      for (var i = 16; i < 64; i++) {
        final int s0 =
            (_rotr(w[i - 15], 7) ^ _rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)) &
            0xffffffff;
        final int s1 =
            (_rotr(w[i - 2], 17) ^ _rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)) &
            0xffffffff;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & 0xffffffff;
      }
      var a = h0, b = h1, c = h2, d = h3;
      var e = h4, f = h5, g = h6, h = h7;
      for (var i = 0; i < 64; i++) {
        final int s1 =
            (_rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25)) & 0xffffffff;
        final int ch = ((e & f) ^ (~e & g)) & 0xffffffff;
        final int t1 = (h + s1 + ch + _k[i] + w[i]) & 0xffffffff;
        final int s0 =
            (_rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22)) & 0xffffffff;
        final int maj = ((a & b) ^ (a & c) ^ (b & c)) & 0xffffffff;
        final int t2 = (s0 + maj) & 0xffffffff;
        h = g;
        g = f;
        f = e;
        e = (d + t1) & 0xffffffff;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) & 0xffffffff;
      }
      h0 = (h0 + a) & 0xffffffff;
      h1 = (h1 + b) & 0xffffffff;
      h2 = (h2 + c) & 0xffffffff;
      h3 = (h3 + d) & 0xffffffff;
      h4 = (h4 + e) & 0xffffffff;
      h5 = (h5 + f) & 0xffffffff;
      h6 = (h6 + g) & 0xffffffff;
      h7 = (h7 + h) & 0xffffffff;
    }
    return <int>[h0, h1, h2, h3, h4, h5, h6, h7]
        .map((int v) => v.toRadixString(16).padLeft(8, '0'))
        .join();
  }

  static int _rotr(int x, int n) =>
      ((x >> n) | (x << (32 - n))) & 0xffffffff;
}
