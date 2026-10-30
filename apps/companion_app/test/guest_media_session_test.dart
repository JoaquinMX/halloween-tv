import 'dart:io';

import 'package:companion_app/src/data/guest_media_client.dart';
import 'package:companion_app/src/session/guest_media_session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class Calls implements GuestMediaCallableInvoker {
  int requests = 0, completions = 0, withdrawals = 0;
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    if (name == kRequestGuestUpload) {
      requests++;
      return {
        'submissionId': 'submission_123',
        'uploadUrl': 'https://upload.example/signed',
        'contentType': 'image/jpeg',
      };
    }
    if (name == kCompleteGuestUpload) {
      completions++;
      return {'status': 'complete'};
    }
    if (name == kGetGuestMediaStatus) return {'status': 'complete'};
    withdrawals++;
    return {'status': 'deletionPending'};
  }
}

class Put implements GuestMediaTransport {
  int count = 0;
  @override
  Future<void> put(Uri uri, File file, String contentType) async {
    count++;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'requires both consent and confirmation before capability; persists receipt and supports withdrawal',
    () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final dir = await Directory.systemTemp.createTemp();
      final photo = File('${dir.path}/source.jpg')..writeAsBytesSync([1, 2, 3]);
      final calls = Calls();
      final put = Put();
      final session = GuestMediaSession(
        client: GuestMediaClient(invoker: calls, transport: put),
        partyId: 'party',
        deviceId: 'device',
        tempDirectory: () async => dir,
      );
      await expectLater(
        session.submit(photo, consent: false, confirmed: true),
        throwsStateError,
      );
      expect(calls.requests, 0);
      await session.submit(photo, consent: true, confirmed: true);
      expect(calls.requests, 1);
      expect(calls.completions, 1);
      expect(put.count, 1);
      expect(prefs.getString(GuestMediaSession.receiptKey), 'submission_123');
      await session.withdraw();
      expect(calls.withdrawals, 1);
      expect(session.status, 'deletionPending');
      await dir.delete(recursive: true);
    },
  );
}
