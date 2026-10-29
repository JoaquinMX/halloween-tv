/// URL signing port: mint expirable playback URIs per clip.
///
/// Design authority: Technical Design v1.0 §10 (delivery).
/// Interfaces ONLY — zero network calls, zero firebase SDK imports.
///
/// Depends on the canonical `core_playlist` [ClipDescriptor] — no local
/// stand-ins. No `dart:io` in this signature.
library;

import 'package:core_playlist/core_playlist.dart';

/// Scheme used by [PassthroughUrlSigner] for unsigned local media.
const String kLocalMediaScheme = 'local';

/// Builds the local, unsigned playback URI for [clip].
///
/// The URI is derived only from [ClipDescriptor.storageObjectId], so it is
/// stable across calls and devices:
/// `local://media/cctv/cam-01.mp4`.
///
/// Throws [ArgumentError] when the storage object id is empty — a clip
/// that cannot be located locally must fail loudly, not silently resolve
/// to the media root.
Uri localMediaUriFor(ClipDescriptor clip) {
  final objectId = clip.storageObjectId.trim();
  if (objectId.isEmpty) {
    throw ArgumentError.value(
      clip.storageObjectId,
      'clip.storageObjectId',
      'cannot build a local URI without a storage object id',
    );
  }
  return Uri(
    scheme: kLocalMediaScheme,
    host: 'media',
    pathSegments: objectId.split('/'),
  );
}

/// Abstract delivery signer: mints an expirable playback [Uri] for a clip.
///
/// Production replaces the passthrough adapter with a Firebase Storage /
/// CDN implementation that returns a time-limited https URL (same port, no
/// caller changes).
abstract interface class UrlSigner {
  /// Returns a playback URI for [clip] that stays valid for at least
  /// [expiry].
  ///
  /// Implementations throw [ArgumentError] for a negative [expiry].
  Future<Uri> signFor(
    ClipDescriptor clip, {
    Duration expiry = const Duration(hours: 1),
  });
}

/// Stub [UrlSigner] that returns the clip's local, unsigned URI.
///
/// Stability guarantee: repeated calls for the same clip return an equal
/// [Uri] regardless of [expiry], so players can cache by URI.
///
/// PRODUCTION REPLACEMENT: swap with a `FirebaseUrlSigner` that resolves
/// [ClipDescriptor.storageObjectId] to a Firebase Storage object and mints
/// a server-expiring signed URL (e.g. `getDownloadURL()` or a Cloud
/// Function-issued token). Port signature ([signFor]) stays unchanged;
/// only the composition root changes.
class PassthroughUrlSigner implements UrlSigner {
  /// Creates an unsigned passthrough signer.
  const PassthroughUrlSigner();

  @override
  Future<Uri> signFor(
    ClipDescriptor clip, {
    Duration expiry = const Duration(hours: 1),
  }) async {
    if (expiry.isNegative) {
      throw ArgumentError.value(expiry, 'expiry', 'must not be negative');
    }
    // No network, no crypto: bundled/local media needs no minting, so the
    // expiry hint does not alter the URI.
    return localMediaUriFor(clip);
  }
}
