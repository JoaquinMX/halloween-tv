import 'dart:io';
import 'dart:typed_data';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:http/http.dart' as http;

const String kRequestGuestUpload = 'requestGuestUpload';
const String kCompleteGuestUpload = 'completeGuestUpload';
const String kGetGuestMediaStatus = 'getGuestMediaStatus';
const String kWithdrawGuestMedia = 'withdrawGuestMedia';

/// Server-side consent envelope.
//
// Pinned to the backend contract of record:
// backend/functions/src/config.ts -> GUEST_CONSENT_TEXT_VERSION ("v1"),
// GUEST_CONSENT_PURPOSE ("guest_cameo"). The backend rejects any other
// textVersion/purpose with INVALID_ARGUMENT; keep these literals in sync
// with that file (no other source of truth on either side).
const String kGuestConsentTextVersion = 'v1';
const String kGuestConsentPurpose = 'guest_cameo';

/// Content types the backend accepts for guest photos.
//
// Pinned to backend/functions/src/config.ts -> GUEST_ALLOWED_CONTENT_TYPES
// (["image/jpeg", "image/png"]). requestGuestUpload rejects anything else
// with INVALID_ARGUMENT; the picker threads one of these through submit.
const List<String> kGuestAllowedContentTypes = <String>[
  'image/jpeg',
  'image/png',
];

abstract interface class GuestMediaCallableInvoker {
  Future<Object?> call(String name, Map<String, Object?> payload);
}

abstract interface class GuestMediaTransport {
  Future<void> put(Uri uri, File file, String contentType);
}

/// Byte transport avoids filesystem and temporary-directory APIs on web.
abstract interface class GuestMediaBytesTransport {
  Future<void> putBytes(Uri uri, Uint8List bytes, String contentType);
}

final class HttpGuestMediaTransport
    implements GuestMediaTransport, GuestMediaBytesTransport {
  HttpGuestMediaTransport({http.Client? client})
    : _client = client ?? http.Client();
  final http.Client _client;
  @override
  Future<void> put(Uri uri, File file, String contentType) async {
    await putBytes(uri, await file.readAsBytes(), contentType);
  }

  @override
  Future<void> putBytes(Uri uri, Uint8List bytes, String contentType) async {
    final response = await _client
        .put(uri, body: bytes, headers: {'content-type': contentType})
        .timeout(const Duration(seconds: 45));
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError('Photo upload failed (${response.statusCode})');
    }
  }
}

final class CallableGuestMediaInvoker implements GuestMediaCallableInvoker {
  CallableGuestMediaInvoker(this._functions);
  final FirebaseFunctions Function() _functions;
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async =>
      (await _functions().httpsCallable(name).call<Object?>(payload)).data;
}

final class GuestUploadCapability {
  const GuestUploadCapability({
    required this.submissionId,
    required this.uploadUrl,
    required this.contentType,
  });
  final String submissionId;
  final Uri uploadUrl;
  final String contentType;
}

final class GuestMediaClient {
  GuestMediaClient({
    required GuestMediaCallableInvoker invoker,
    required GuestMediaTransport transport,
  }) : _invoker = invoker,
       _transport = transport;
  final GuestMediaCallableInvoker _invoker;
  final GuestMediaTransport _transport;
  Map<String, Object?> _scope(String partyId, String deviceId) => {
    'partyId': partyId,
    'deviceId': deviceId,
  };

  Future<GuestUploadCapability> requestUpload({
    required String partyId,
    required String deviceId,
    required String channelId,
    required String contentType,
    required int byteSize,
    required bool affirmativeConsent,
  }) async {
    if (!affirmativeConsent) {
      throw StateError('Affirmative guest photo consent is required');
    }
    final raw = await _invoker
        .call(kRequestGuestUpload, {
          ..._scope(partyId, deviceId),
          'channelId': channelId,
          'contentType': contentType,
          'byteSize': byteSize,
          'consent': {
            'accepted': true,
            'textVersion': kGuestConsentTextVersion,
            'purpose': kGuestConsentPurpose,
          },
        })
        .timeout(const Duration(seconds: 15));
    if (raw is! Map ||
        raw['submissionId'] is! String ||
        raw['uploadUrl'] is! String) {
      throw const FormatException('Upload capability response is malformed');
    }
    // The backend never echoes contentType (see guest_upload.ts:
    // requestGuestUpload returns {submissionId, objectPath, uploadUrl,
    // expiresAt, consentRevision} only). The PUT below uses the caller's
    // contentType, which the backend bound into the signed URL.
    final uri = Uri.tryParse(raw['uploadUrl'] as String);
    if (uri == null ||
        uri.scheme != 'https' ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty) {
      throw const FormatException('Upload capability URL is invalid');
    }
    final id = raw['submissionId'] as String;
    // Backend validateId shape (contracts.ts ID_RE): leading alnum, then
    // alnum/_/-, max 128 chars. The server mints `gsub-<32 hex>`.
    if (!RegExp(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$').hasMatch(id)) {
      throw const FormatException('Submission receipt is invalid');
    }
    return GuestUploadCapability(
      submissionId: id,
      uploadUrl: uri,
      contentType: contentType,
    );
  }

  Future<void> upload(GuestUploadCapability capability, File file) =>
      _transport.put(capability.uploadUrl, file, capability.contentType);

  Future<void> uploadBytes(GuestUploadCapability capability, Uint8List bytes) {
    final transport = _transport;
    if (transport is! GuestMediaBytesTransport) {
      throw StateError('Photo byte upload transport is unavailable');
    }
    return (transport as GuestMediaBytesTransport).putBytes(
      capability.uploadUrl,
      bytes,
      capability.contentType,
    );
  }

  Future<void> complete({
    required String partyId,
    required String deviceId,
    required String channelId,
    required String submissionId,
  }) async {
    await _invoker
        .call(kCompleteGuestUpload, {
          ..._scope(partyId, deviceId),
          'channelId': channelId,
          'submissionId': submissionId,
        })
        .timeout(const Duration(seconds: 15));
  }

  Future<Map<String, Object?>> status({
    required String partyId,
    required String deviceId,
    required String channelId,
    required String submissionId,
  }) async {
    final raw = await _invoker
        .call(kGetGuestMediaStatus, {
          ..._scope(partyId, deviceId),
          'channelId': channelId,
          'submissionId': submissionId,
        })
        .timeout(const Duration(seconds: 15));
    if (raw is! Map) {
      throw const FormatException('Media status response is malformed');
    }
    return Map<String, Object?>.from(raw);
  }

  Future<Map<String, Object?>> withdraw({
    required String partyId,
    required String deviceId,
    required String channelId,
    required String submissionId,
  }) async {
    final raw = await _invoker
        .call(kWithdrawGuestMedia, {
          ..._scope(partyId, deviceId),
          'channelId': channelId,
          'submissionId': submissionId,
        })
        .timeout(const Duration(seconds: 15));
    if (raw is! Map || raw['status'] is! String) {
      throw const FormatException('Withdrawal response is malformed');
    }
    // Backend terminal status (guest_upload.ts WithdrawGuestMediaResult):
    // exactly 'withdrawn'. Anything else is a contract violation.
    final String returnedStatus = raw['status'] as String;
    if (returnedStatus != 'withdrawn') {
      throw const FormatException('Withdrawal response is malformed');
    }
    return Map<String, Object?>.from(raw);
  }
}
