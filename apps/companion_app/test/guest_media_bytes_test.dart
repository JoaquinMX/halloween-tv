import 'dart:typed_data';

import 'package:companion_app/src/data/guest_media_client.dart';
import 'package:companion_app/src/session/guest_media_session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

final class _Invoker implements GuestMediaCallableInvoker {
  final List<String> calls = <String>[];
  Map<String, Object?>? request;
  bool failCompletion = false;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    calls.add(name);
    if (name == kRequestGuestUpload) {
      request = payload;
      return <String, Object?>{
        'submissionId': 'gsub-test',
        'uploadUrl': 'https://example.test/upload',
      };
    }
    if (name == kCompleteGuestUpload) {
      if (failCompletion) throw StateError('offline');
      return <String, Object?>{};
    }
    throw StateError('Unexpected callable $name');
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  test(
    'browser bytes require both consent gates before any capability',
    () async {
      final invoker = _Invoker();
      final session = GuestMediaSession(
        client: GuestMediaClient(
          invoker: invoker,
          transport: HttpGuestMediaTransport(
            client: MockClient((_) async {
              fail('No upload before consent');
            }),
          ),
        ),
        partyId: 'party',
        deviceId: 'device',
        channelId: 'channel',
      );
      for (final gate in <(bool, bool)>[(false, true), (true, false)]) {
        await expectLater(
          session.submitBytes(
            Uint8List.fromList([1, 2]),
            consent: gate.$1,
            confirmed: gate.$2,
            contentType: 'image/png',
          ),
          throwsStateError,
        );
      }
      expect(invoker.calls, isEmpty);
      expect(session.busy, isFalse);
    },
  );

  test(
    'browser upload sends exact bytes and MIME after persisting receipt',
    () async {
      final invoker = _Invoker();
      final bytes = Uint8List.fromList([137, 80, 78, 71]);
      int puts = 0;
      final session = GuestMediaSession(
        client: GuestMediaClient(
          invoker: invoker,
          transport: HttpGuestMediaTransport(
            client: MockClient((request) async {
              puts++;
              expect(request.method, 'PUT');
              expect(request.headers['content-type'], 'image/png');
              expect(request.bodyBytes, orderedEquals(bytes));
              final prefs = await SharedPreferences.getInstance();
              expect(prefs.getStringList(GuestMediaSession.receiptsKey), [
                'gsub-test',
              ]);
              return http.Response('', 200);
            }),
          ),
        ),
        partyId: 'party',
        deviceId: 'device',
        channelId: 'channel',
        tempDirectory: () async =>
            throw StateError('Web must not access filesystem'),
      );
      await session.submitBytes(
        bytes,
        consent: true,
        confirmed: true,
        contentType: 'image/png',
      );
      expect(puts, 1);
      expect(invoker.calls, [kRequestGuestUpload, kCompleteGuestUpload]);
      expect(invoker.request?['byteSize'], bytes.length);
      expect(invoker.request?['consent'], {
        'accepted': true,
        'textVersion': kGuestConsentTextVersion,
        'purpose': kGuestConsentPurpose,
      });
      expect(session.status, 'complete');
      expect(session.busy, isFalse);
    },
  );

  test(
    'failed browser completion retains withdrawal receipt and unlocks UI',
    () async {
      final invoker = _Invoker()..failCompletion = true;
      final session = GuestMediaSession(
        client: GuestMediaClient(
          invoker: invoker,
          transport: HttpGuestMediaTransport(
            client: MockClient((_) async => http.Response('', 200)),
          ),
        ),
        partyId: 'party',
        deviceId: 'device',
        channelId: 'channel',
      );
      await expectLater(
        session.submitBytes(
          Uint8List.fromList([1]),
          consent: true,
          confirmed: true,
          contentType: 'image/jpeg',
        ),
        throwsStateError,
      );
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getStringList(GuestMediaSession.receiptsKey), ['gsub-test']);
      expect(session.status, 'recovery-required');
      expect(session.busy, isFalse);
    },
  );
}
