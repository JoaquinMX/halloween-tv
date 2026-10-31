/// Firebase callable adapter for short-lived media delivery and ACKs.
library;

import 'package:cloud_functions/cloud_functions.dart';
import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:infra_firestore/infra_firestore.dart';

import 'package:infra_signed_urls/src/url_signer.dart';

final RegExp _sha256 = RegExp(r'^[0-9a-fA-F]{64}$');

/// Injectable callable boundary for deterministic tests and callable emulator
/// wiring. Production uses the Firebase Functions SDK adapter by default.
abstract interface class FirebaseCallableInvoker {
  Future<Object?> call(String name, Map<String, Object?> payload);
}

final class _SdkFirebaseCallableInvoker implements FirebaseCallableInvoker {
  _SdkFirebaseCallableInvoker(this._functions);

  final FirebaseFunctions _functions;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    final HttpsCallableResult<Object?> result = await _functions
        .httpsCallable(name)
        .call<Object?>(payload);
    return result.data;
  }
}

/// One object-specific signed delivery URL and its server-enforced expiry.
final class FirebaseDeliveryClipUrl {
  FirebaseDeliveryClipUrl({
    required this.cameraId,
    required this.sha256,
    required this.url,
    required this.expiresAt,
  }) {
    if (!_sha256.hasMatch(sha256)) {
      throw const FormatException('delivery clip sha256 must be 64 hex chars');
    }
    if (url.scheme != 'https' || url.host.isEmpty || url.userInfo.isNotEmpty) {
      throw const FormatException('delivery URL must be an HTTPS URL');
    }
    if (slotForCameraId(cameraId) == null) {
      throw FormatException('unknown delivery cameraId: $cameraId');
    }
  }

  final String cameraId;
  final String sha256;
  final Uri url;
  final DateTime expiresAt;
}

/// Validated result from the `getDeliveryUrls` callable.
///
/// `manifestVersion` and `manifestHash` are validated as response fields, but
/// URL reuse is intentionally keyed only by cameraId plus SHA-256. The TV does
/// not request a particular manifest from this callable, so those fields are
/// not compared to a requested manifest.
final class FirebaseDeliveryUrls {
  FirebaseDeliveryUrls({
    required this.manifestVersion,
    required this.manifestHash,
    required List<FirebaseDeliveryClipUrl> clips,
  }) : clips = List<FirebaseDeliveryClipUrl>.unmodifiable(clips) {
    if (manifestVersion <= 0 || !_sha256.hasMatch(manifestHash)) {
      throw const FormatException(
        'delivery response has invalid manifest data',
      );
    }
    final Set<String> cameras = this.clips.map((clip) => clip.cameraId).toSet();
    // 1/2/4-camera layouts: the response must carry exactly the first-N
    // canonical cameras (reordered clips are fine; gaps and extras rejected).
    if (!isSupportedCctvClipCount(this.clips.length)) {
      throw const FormatException(
        'delivery response must contain one URL per canonical camera',
      );
    }
    final List<String> expected = expectedCctvCameraIds(this.clips.length);
    if (cameras.length != this.clips.length ||
        cameras.length != expected.length ||
        !cameras.containsAll(expected)) {
      throw const FormatException(
        'delivery response must contain one URL per canonical camera',
      );
    }
  }

  final int manifestVersion;
  final String manifestHash;
  final List<FirebaseDeliveryClipUrl> clips;
}

/// Party/device-scoped callable client. Firebase callable auth tokens are
/// attached by the SDK when available; an anonymous TV needs no login and the
/// server validates every supplied party/device registration.
final class FirebaseDeliveryClient implements DeliveryAcknowledger {
  FirebaseDeliveryClient({
    required FirebaseTvIdentity identity,
    FirebaseFunctions? functions,
    FirebaseCallableInvoker? callableInvoker,
    DateTime Function()? now,
  }) : _identity = identity,
       _functions = functions,
       _callableInvoker = callableInvoker,
       _now = now ?? DateTime.now {
    if (functions != null && callableInvoker != null) {
      throw ArgumentError(
        'provide either functions or callableInvoker, not both',
      );
    }
  }

  final FirebaseTvIdentity _identity;
  final FirebaseFunctions? _functions;
  final FirebaseCallableInvoker? _callableInvoker;
  final DateTime Function() _now;

  Future<Object?> _call(String name, Map<String, Object?> payload) {
    final FirebaseCallableInvoker invoker =
        _callableInvoker ??
        _SdkFirebaseCallableInvoker(_functions ?? FirebaseFunctions.instance);
    return invoker.call(name, payload);
  }

  /// Fetches the server's short-lived signed URL for each current object.
  /// A subsequent call can refresh URLs without changing manifest version.
  Future<FirebaseDeliveryUrls> getDeliveryUrls({
    required String channelId,
  }) async {
    final Object? raw = await _call(
      'getDeliveryUrls',
      _identity.callablePayload(channelId: channelId),
    );
    if (raw is! Map) {
      throw const FormatException('getDeliveryUrls response must be an object');
    }
    final Object? rawVersion = raw['manifestVersion'];
    final Object? rawHash = raw['manifestHash'];
    final Object? rawClips = raw['clips'];
    if (rawVersion is! num ||
        rawVersion.toInt() != rawVersion ||
        rawHash is! String ||
        rawClips is! List) {
      throw const FormatException('getDeliveryUrls response is incomplete');
    }
    final List<FirebaseDeliveryClipUrl> clips = <FirebaseDeliveryClipUrl>[];
    for (final Object? value in rawClips) {
      if (value is! Map ||
          value['cameraId'] is! String ||
          value['sha256'] is! String ||
          value['url'] is! String ||
          value['expiresAt'] is! String) {
        throw const FormatException('getDeliveryUrls clip entry is invalid');
      }
      final DateTime expiresAt;
      try {
        expiresAt = DateTime.parse(value['expiresAt']! as String).toUtc();
      } on FormatException {
        throw const FormatException('delivery URL expiresAt is invalid');
      }
      if (!expiresAt.isAfter(_now().toUtc())) {
        throw const FormatException('delivery URL is already expired');
      }
      clips.add(
        FirebaseDeliveryClipUrl(
          cameraId: value['cameraId']! as String,
          sha256: value['sha256']! as String,
          url: Uri.parse(value['url']! as String),
          expiresAt: expiresAt,
        ),
      );
    }
    return FirebaseDeliveryUrls(
      manifestVersion: rawVersion.toInt(),
      manifestHash: rawHash,
      clips: clips,
    );
  }

  /// Gets a fresh URL for this exact camera content. Hash matching makes a
  /// concurrent manifest update safe: another clip cannot be substituted.
  /// This does not compare the returned manifestVersion or manifestHash with
  /// the prepared manifest; the server response has no requested-version
  /// binding. The caller still ACKs only its prepared version.
  Future<Uri> refreshUrlFor({
    required String channelId,
    required ClipDescriptor clip,
  }) async {
    final FirebaseDeliveryUrls response = await getDeliveryUrls(
      channelId: channelId,
    );
    for (final FirebaseDeliveryClipUrl item in response.clips) {
      if (item.cameraId == clip.cameraId &&
          item.sha256.toLowerCase() == clip.sha256.toLowerCase()) {
        return item.url;
      }
    }
    throw StateError(
      'current manifest no longer contains ${clip.cameraId} with the '
      'requested sha256',
    );
  }

  @override
  Future<void> acknowledge({
    required String partyId,
    required String channelId,
    required int manifestVersion,
    required Map<String, String> verifiedClipHashes,
  }) async {
    if (partyId != _identity.partyId) {
      throw ArgumentError.value(partyId, 'partyId', 'does not match identity');
    }
    // ACK covers the complete received manifest (1, 2, or 4 clips): the hash
    // set must exactly equal the first-N canonical prefix — reduced layouts
    // still ACK every received clip, extras rejected.
    if (manifestVersion <= 0 ||
        !isSupportedCctvClipCount(verifiedClipHashes.length)) {
      throw ArgumentError(
        'ACK requires a positive version and one hash for each canonical camera',
      );
    }
    final List<String> expectedCameras = expectedCctvCameraIds(
      verifiedClipHashes.length,
    );
    if (!verifiedClipHashes.keys.toSet().containsAll(expectedCameras)) {
      throw ArgumentError(
        'ACK requires a positive version and one hash for each canonical camera',
      );
    }
    final Set<String> canonicalCameras = expectedCameras.toSet();
    final Map<String, String> hashes = <String, String>{};
    for (final String cameraId in canonicalCameras) {
      final String hash = verifiedClipHashes[cameraId]!.toLowerCase();
      if (!_sha256.hasMatch(hash)) {
        throw ArgumentError.value(hash, 'verifiedClipHashes[$cameraId]');
      }
      hashes[cameraId] = hash;
    }
    final Object? raw = await _call('acknowledgeDelivery', <String, Object?>{
      ..._identity.callablePayload(channelId: channelId),
      'manifestVersion': manifestVersion,
      'clipHashes': hashes,
    });
    if (raw is! Map) {
      throw const FormatException(
        'acknowledgeDelivery response must be an object',
      );
    }
    final Object? ackId = raw['ackId'];
    final Object? responseVersion = raw['manifestVersion'];
    final Object? purged = raw['purged'];
    if (ackId is! String || ackId.trim().isEmpty) {
      throw const FormatException('acknowledgeDelivery ackId is invalid');
    }
    if (responseVersion is! num ||
        responseVersion.toInt() != responseVersion ||
        responseVersion.toInt() != manifestVersion) {
      throw const FormatException(
        'acknowledgeDelivery manifestVersion does not match request',
      );
    }
    if (purged is! bool || !purged) {
      throw const FormatException('acknowledgeDelivery purged is invalid');
    }
  }
}

/// Existing UrlSigner port adapter backed by per-object callable URLs.
final class FirebaseUrlSigner implements UrlSigner {
  FirebaseUrlSigner({
    required FirebaseDeliveryClient deliveryClient,
    required this.channelId,
  }) : _deliveryClient = deliveryClient;

  final FirebaseDeliveryClient _deliveryClient;
  final String channelId;

  @override
  Future<Uri> signFor(
    ClipDescriptor clip, {
    Duration expiry = const Duration(hours: 1),
  }) async {
    if (expiry.isNegative) {
      throw ArgumentError.value(expiry, 'expiry', 'must not be negative');
    }
    return _deliveryClient.refreshUrlFor(channelId: channelId, clip: clip);
  }
}
