import 'dart:io';

import 'package:companion_app/src/data/guest_media_client.dart';
import 'package:flutter_test/flutter_test.dart';

/// Backend-faithful fake: requestGuestUpload returns exactly
/// {submissionId, objectPath, uploadUrl, expiresAt, consentRevision} (NO
/// contentType echo — see backend/functions/src/guest_upload.ts), terminal
/// withdrawal status is exactly 'withdrawn' (WithdrawGuestMediaResult), and
/// complete/status/withdraw REQUIRE channelId (INVALID_ARGUMENT when empty).
class Invoker implements GuestMediaCallableInvoker {
  final calls = <(String, Map<String, Object?>)>[];
  Object? response = <String, Object?>{
    'submissionId': 'gsub-0123456789abcdef0123456789abcdef',
    'objectPath':
        'parties/party-x/guests/p-aaa/ingest/gsub-0123456789abcdef0123456789abcdef/photo.jpg',
    'uploadUrl':
        'https://storage.example/signed?token=secret',
    'expiresAt': '2030-01-01T00:00:00.000Z',
    'consentRevision': 'v1:2026-10-30T00:00:00.000Z',
  };
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    calls.add((name, payload));
    if (name == kCompleteGuestUpload ||
        name == kGetGuestMediaStatus ||
        name == kWithdrawGuestMedia) {
      if (payload['channelId'] is! String ||
          (payload['channelId'] as String).isEmpty) {
        throw StateError('INVALID_ARGUMENT: channelId is required');
      }
    }
    if (name == kWithdrawGuestMedia) {
      return <String, Object?>{
        'submissionId': payload['submissionId'],
        'status': 'withdrawn',
        'deletedObjects': <String>['parties/party-x/object'],
        'verifiedAbsent': true,
      };
    }
    return response;
  }
}

class Transport implements GuestMediaTransport {
  int uploads = 0;
  String? lastContentType;
  @override
  Future<void> put(Uri uri, File file, String contentType) async {
    uploads++;
    lastContentType = contentType;
  }
}

void main() {
  test(
    'capability request is scoped and malformed URL is rejected before transport',
    () async {
      final invoker = Invoker();
      final transport = Transport();
      final client = GuestMediaClient(invoker: invoker, transport: transport);
      final cap = await client.requestUpload(
        partyId: 'party-x',
        deviceId: 'p-${List.filled(32, 'a').join()}',
        channelId: 'cctv',
        contentType: 'image/jpeg',
        byteSize: 42,
        affirmativeConsent: true,
      );
      expect(cap.submissionId, 'gsub-0123456789abcdef0123456789abcdef');
      expect(invoker.calls.single.$1, kRequestGuestUpload);
      expect(invoker.calls.single.$2['partyId'], 'party-x');
      expect(invoker.calls.single.$2['channelId'], 'cctv');
      expect(invoker.calls.single.$2['contentType'], 'image/jpeg');
      expect(invoker.calls.single.$2['byteSize'], 42);
      final Object? consent = invoker.calls.single.$2['consent'];
      expect(consent, <String, Object?>{
        'accepted': true,
        'textVersion': kGuestConsentTextVersion,
        'purpose': kGuestConsentPurpose,
      });
      expect(kGuestConsentTextVersion, 'v1');
      expect(kGuestConsentPurpose, 'guest_cameo');
      invoker.response = {
        'submissionId': 'gsub-0123456789abcdef0123456789abcdef',
        'uploadUrl': 'http://bad.invalid/x',
        'objectPath': 'parties/party-x/photo.jpg',
        'expiresAt': '2030-01-01T00:00:00.000Z',
        'consentRevision': 'v1:2026-10-30T00:00:00.000Z',
      };
      await expectLater(
        client.requestUpload(
          partyId: 'party-x',
          deviceId: 'p-${List.filled(32, 'a').join()}',
          channelId: 'cctv',
          contentType: 'image/jpeg',
          byteSize: 42,
          affirmativeConsent: true,
        ),
        throwsFormatException,
      );
      expect(transport.uploads, 0);
    },
  );
  test('requestUpload refuses without affirmative consent before any network', () async {
    final invoker = Invoker();
    final transport = Transport();
    final client = GuestMediaClient(invoker: invoker, transport: transport);
    await expectLater(
      client.requestUpload(
        partyId: 'party-x',
        deviceId: 'p-${List.filled(32, 'a').join()}',
        channelId: 'cctv',
        contentType: 'image/jpeg',
        byteSize: 42,
        affirmativeConsent: false,
      ),
      throwsStateError,
    );
    expect(invoker.calls, isEmpty);
  });

  test(
    'backend capability without a contentType echo is accepted and the PUT uses the caller contentType',
    () async {
      // Regression: the backend never echoes contentType, so the client must
      // not demand it — every upload used to fail here.
      final invoker = Invoker();
      final transport = Transport();
      final client = GuestMediaClient(invoker: invoker, transport: transport);
      final dir = await Directory.systemTemp.createTemp();
      try {
        final file = File('${dir.path}/photo.png')
          ..writeAsBytesSync(<int>[1, 2, 3]);
        final cap = await client.requestUpload(
          partyId: 'party-x',
          deviceId: 'p-${List.filled(32, 'a').join()}',
          channelId: 'cctv',
          contentType: 'image/png',
          byteSize: 3,
          affirmativeConsent: true,
        );
        expect(cap.contentType, 'image/png');
        await client.upload(cap, file);
        expect(transport.uploads, 1);
        expect(transport.lastContentType, 'image/png');
      } finally {
        await dir.delete(recursive: true);
      }
    },
  );

  test('malformed submission ids are rejected before transport', () async {
    final invoker = Invoker();
    final transport = Transport();
    final client = GuestMediaClient(invoker: invoker, transport: transport);
    for (final bad in <String>[
      '',
      '/evil',
      '-leading-dash',
      '_leading_underscore',
      'has space',
      'gsub-${List.filled(200, 'a').join()}',
    ]) {
      invoker.response = <String, Object?>{
        'submissionId': bad,
        'uploadUrl': 'https://storage.example/signed',
        'objectPath': 'parties/party-x/photo.jpg',
        'expiresAt': '2030-01-01T00:00:00.000Z',
        'consentRevision': 'v1:2026-10-30T00:00:00.000Z',
      };
      await expectLater(
        client.requestUpload(
          partyId: 'party-x',
          deviceId: 'p-${List.filled(32, 'a').join()}',
          channelId: 'cctv',
          contentType: 'image/jpeg',
          byteSize: 42,
          affirmativeConsent: true,
        ),
        throwsFormatException,
        reason: 'submission id $bad must be rejected',
      );
    }
    expect(transport.uploads, 0);
  });

  test(
    'complete/status/withdraw forward channelId and withdrawn is terminal',
    () async {
      final invoker = Invoker();
      final transport = Transport();
      final client = GuestMediaClient(invoker: invoker, transport: transport);
      const submissionId = 'gsub-0123456789abcdef0123456789abcdef';
      await client.complete(
        partyId: 'party-x',
        deviceId: 'device',
        channelId: 'cctv',
        submissionId: submissionId,
      );
      expect(invoker.calls.single.$1, kCompleteGuestUpload);
      expect(invoker.calls.single.$2['channelId'], 'cctv');
      expect(invoker.calls.single.$2['submissionId'], submissionId);

      invoker.calls.clear();
      invoker.response = <String, Object?>{
        'submissionId': submissionId,
        'status': 'eligible',
      };
      final status = await client.status(
        partyId: 'party-x',
        deviceId: 'device',
        channelId: 'cctv',
        submissionId: submissionId,
      );
      expect(invoker.calls.single.$1, kGetGuestMediaStatus);
      expect(invoker.calls.single.$2['channelId'], 'cctv');
      expect(status['status'], 'eligible');

      invoker.calls.clear();
      final withdrawn = await client.withdraw(
        partyId: 'party-x',
        deviceId: 'device',
        channelId: 'cctv',
        submissionId: submissionId,
      );
      expect(invoker.calls.single.$1, kWithdrawGuestMedia);
      expect(invoker.calls.single.$2['channelId'], 'cctv');
      expect(withdrawn['status'], 'withdrawn');
      expect(withdrawn['verifiedAbsent'], isTrue);
    },
  );
}
