import 'dart:io';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:http/http.dart' as http;

const String kRequestGuestUpload = 'requestGuestUpload';
const String kCompleteGuestUpload = 'completeGuestUpload';
const String kGetGuestMediaStatus = 'getGuestMediaStatus';
const String kWithdrawGuestMedia = 'withdrawGuestMedia';

abstract interface class GuestMediaCallableInvoker {
  Future<Object?> call(String name, Map<String, Object?> payload);
}

abstract interface class GuestMediaTransport {
  Future<void> put(Uri uri, File file, String contentType);
}

final class HttpGuestMediaTransport implements GuestMediaTransport {
  HttpGuestMediaTransport({http.Client? client})
    : _client = client ?? http.Client();
  final http.Client _client;
  @override
  Future<void> put(Uri uri, File file, String contentType) async {
    final response = await _client
        .put(
          uri,
          body: await file.readAsBytes(),
          headers: {'content-type': contentType},
        )
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
          'contentType': contentType,
          'byteSize': byteSize,
          'consent': true,
          'consentVersion': 'guest-photo-v1',
        })
        .timeout(const Duration(seconds: 15));
    if (raw is! Map ||
        raw['submissionId'] is! String ||
        raw['uploadUrl'] is! String ||
        raw['contentType'] != contentType) {
      throw const FormatException('Upload capability response is malformed');
    }
    final uri = Uri.tryParse(raw['uploadUrl'] as String);
    if (uri == null ||
        uri.scheme != 'https' ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty) {
      throw const FormatException('Upload capability URL is invalid');
    }
    final id = raw['submissionId'] as String;
    if (!RegExp(r'^[A-Za-z0-9_-]{8,128}$').hasMatch(id)) {
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
  Future<void> complete({
    required String partyId,
    required String deviceId,
    required String submissionId,
  }) async {
    await _invoker
        .call(kCompleteGuestUpload, {
          ..._scope(partyId, deviceId),
          'submissionId': submissionId,
        })
        .timeout(const Duration(seconds: 15));
  }

  Future<Map<String, Object?>> status({
    required String partyId,
    required String deviceId,
    required String submissionId,
  }) async {
    final raw = await _invoker
        .call(kGetGuestMediaStatus, {
          ..._scope(partyId, deviceId),
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
    required String submissionId,
  }) async {
    final raw = await _invoker
        .call(kWithdrawGuestMedia, {
          ..._scope(partyId, deviceId),
          'submissionId': submissionId,
        })
        .timeout(const Duration(seconds: 15));
    if (raw is! Map || raw['status'] is! String) {
      throw const FormatException('Withdrawal response is malformed');
    }
    final String returnedStatus = raw['status'] as String;
    if (!const {
      'recorded',
      'withdrawalRecorded',
      'withdrawal_recorded',
      'deletionPending',
      'deletion_pending',
      'deleted',
    }.contains(returnedStatus)) {
      throw const FormatException('Withdrawal response is malformed');
    }
    return Map<String, Object?>.from(raw);
  }
}
