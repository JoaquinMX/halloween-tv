import 'dart:io';

import 'package:companion_app/src/data/guest_media_client.dart';
import 'package:flutter_test/flutter_test.dart';

class Invoker implements GuestMediaCallableInvoker {
  final calls = <(String, Map<String, Object?>)>[];
  Object? response = {
    'submissionId': 'submit_12345678',
    'uploadUrl': 'https://storage.example/signed?token=secret',
    'contentType': 'image/jpeg',
  };
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    calls.add((name, payload));
    return response;
  }
}

class Transport implements GuestMediaTransport {
  int uploads = 0;
  @override
  Future<void> put(Uri uri, File file, String contentType) async {
    uploads++;
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
      expect(cap.submissionId, 'submit_12345678');
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
        'submissionId': 'submit_12345678',
        'uploadUrl': 'http://bad.invalid/x',
        'contentType': 'image/jpeg',
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
}
