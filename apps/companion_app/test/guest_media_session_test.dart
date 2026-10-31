import 'dart:io';

import 'package:companion_app/src/data/guest_media_client.dart';
import 'package:companion_app/src/session/guest_media_session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Backend-faithful fake (see backend/functions/src/guest_upload.ts):
/// requestGuestUpload mints `gsub-<32 hex>` WITHOUT a contentType echo;
/// complete/status/withdraw REQUIRE channelId; statuses are the backend
/// GuestMediaStatus values (pending_upload | eligible | withdrawn | expired);
/// withdrawal is terminal with status 'withdrawn'.
class Calls implements GuestMediaCallableInvoker {
  int requests = 0, completions = 0, withdrawals = 0, statuses = 0;
  int next = 0;
  final Map<String, String> states = <String, String>{};
  final List<Map<String, Object?>> envelopes = <Map<String, Object?>>[];
  String mintId() {
    next++;
    return 'gsub-${next.toRadixString(16).padLeft(32, '0')}';
  }

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    if (name == kRequestGuestUpload) {
      requests++;
      if (payload['channelId'] != 'cctv') {
        throw StateError('channelId is required (got ${payload['channelId']})');
      }
      final Object? consent = payload['consent'];
      if (consent is! Map<String, Object?> ||
          consent['accepted'] != true ||
          consent['textVersion'] != 'v1' ||
          consent['purpose'] != 'guest_cameo') {
        throw StateError('affirmative consent object is required');
      }
      final String submissionId = mintId();
      states[submissionId] = 'eligible';
      envelopes.add(Map<String, Object?>.of(payload));
      return <String, Object?>{
        'submissionId': submissionId,
        'objectPath': 'parties/party/guests/device/ingest/$submissionId/photo.jpg',
        'uploadUrl': 'https://upload.example/signed/$submissionId',
        'expiresAt': '2030-01-01T00:00:00.000Z',
        'consentRevision': 'v1:2026-10-30T00:00:00.000Z',
      };
    }
    if (payload['channelId'] != 'cctv') {
      throw StateError('INVALID_ARGUMENT: channelId is required for $name');
    }
    if (name == kCompleteGuestUpload) {
      completions++;
      return <String, Object?>{
        'submissionId': payload['submissionId'],
        'status': 'eligible',
      };
    }
    if (name == kGetGuestMediaStatus) {
      statuses++;
      final String id = payload['submissionId'] as String;
      return <String, Object?>{
        'submissionId': id,
        'status': states[id] ?? 'eligible',
      };
    }
    withdrawals++;
    final String id = payload['submissionId'] as String;
    states[id] = 'withdrawn';
    return <String, Object?>{
      'submissionId': id,
      'status': 'withdrawn',
      'deletedObjects': <String>['parties/party/object/$id'],
      'verifiedAbsent': true,
    };
  }
}

class Put implements GuestMediaTransport {
  int count = 0;
  final List<String> contentTypes = <String>[];
  @override
  Future<void> put(Uri uri, File file, String contentType) async {
    count++;
    contentTypes.add(contentType);
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
        channelId: 'cctv',
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
      expect(
        put.contentTypes.single,
        'image/jpeg',
        reason: 'default content type threads to the PUT',
      );
      final String first = session.submissionId!;
      expect(
        first,
        matches(RegExp(r'^gsub-[0-9a-f]{32}$')),
        reason: 'server-assigned submission id shape',
      );
      expect(prefs.getStringList(GuestMediaSession.receiptsKey), <String>[first]);
      // Legacy single-slot key mirrors the latest id.
      expect(prefs.getString(GuestMediaSession.receiptKey), first);
      // The completion envelope carries the session channelId.
      expect(calls.envelopes.single['channelId'], 'cctv');
      await session.withdraw();
      expect(calls.withdrawals, 1);
      expect(session.status, 'withdrawn');
      expect(session.submissionId, isNull);
      expect(prefs.getStringList(GuestMediaSession.receiptsKey), isEmpty);
      expect(prefs.getString(GuestMediaSession.receiptKey), isNull);
      await dir.delete(recursive: true);
    },
  );

  test(
    'two submissions keep scoped receipts; withdrawing the first resolves both',
    () async {
      // Regression: each submit used to overwrite the sole persisted receipt,
      // stranding the earlier submission without a withdrawal path.
      SharedPreferences.setMockInitialValues({});
      final dir = await Directory.systemTemp.createTemp();
      final photo = File('${dir.path}/source.jpg')..writeAsBytesSync([1, 2, 3]);
      final calls = Calls();
      final session = GuestMediaSession(
        client: GuestMediaClient(invoker: calls, transport: Put()),
        partyId: 'party',
        deviceId: 'device',
        channelId: 'cctv',
        tempDirectory: () async => dir,
      );
      await session.submit(
        photo,
        consent: true,
        confirmed: true,
        contentType: 'image/png',
      );
      final String first = session.submissionId!;
      await session.submit(photo, consent: true, confirmed: true);
      final String second = session.submissionId!;
      expect(first, isNot(second));
      expect(session.submissionIds, <String>[first, second]);

      // Withdraw the FIRST submission while the second is outstanding.
      await session.withdraw(submissionId: first);
      expect(calls.withdrawals, 1);
      expect(session.submissionIds, <String>[second]);
      expect(session.statuses[first], isNull);
      expect(session.submissionId, second);

      // The surviving submission still resolves: status reads back through
      // the real session path with its channelId.
      await session.recover();
      expect(session.submissionIds, <String>[second]);
      expect(session.statuses[second], 'eligible');

      // And the second withdrawal resolves too.
      await session.withdraw();
      expect(calls.withdrawals, 2);
      expect(session.submissionIds, isEmpty);
      expect(session.status, 'withdrawn');
      await dir.delete(recursive: true);
    },
  );

  test('recover drops verified withdrawals and keeps the rest', () async {
    SharedPreferences.setMockInitialValues({});
    final dir = await Directory.systemTemp.createTemp();
    final photo = File('${dir.path}/source.jpg')..writeAsBytesSync([1, 2, 3]);
    final calls = Calls();
    final session = GuestMediaSession(
      client: GuestMediaClient(invoker: calls, transport: Put()),
      partyId: 'party',
      deviceId: 'device',
      channelId: 'cctv',
      tempDirectory: () async => dir,
    );
    await session.submit(photo, consent: true, confirmed: true);
    await session.submit(photo, consent: true, confirmed: true);
    final String first = session.submissionIds.first;
    final String second = session.submissionIds.last;
    // External withdrawal (another launch): the next recover observes the
    // backend terminal state and clears only that receipt.
    calls.states[first] = 'withdrawn';
    await session.recover();
    expect(session.submissionIds, <String>[second]);
    expect(session.statuses[second], 'eligible');
    await dir.delete(recursive: true);
  });

  test(
    'host source-photo uploads reuse the workflow under separate receipts',
    () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final dir = await Directory.systemTemp.createTemp();
      final photo = File('${dir.path}/source.jpg')..writeAsBytesSync([1, 2, 3]);
      final calls = Calls();
      final guest = GuestMediaSession(
        client: GuestMediaClient(invoker: calls, transport: Put()),
        partyId: 'party',
        deviceId: 'guest-device',
        channelId: 'cctv',
        tempDirectory: () async => dir,
      );
      final host = GuestMediaSession(
        client: GuestMediaClient(invoker: calls, transport: Put()),
        partyId: 'party',
        deviceId: 'host-device',
        channelId: 'cctv',
        tempDirectory: () async => dir,
        receiptsKey: GuestMediaSession.hostReceiptsKey,
        receiptKey: GuestMediaSession.hostReceiptKey,
      );
      await guest.submit(photo, consent: true, confirmed: true);
      await host.submit(photo, consent: true, confirmed: true);
      expect(guest.submissionId, isNot(host.submissionId));
      // Namespaced receipts never share storage: withdrawing the host photo
      // leaves the guest receipt (and its withdrawal path) untouched.
      expect(
        prefs.getStringList(GuestMediaSession.receiptsKey),
        <String>[guest.submissionId!],
      );
      expect(
        prefs.getStringList(GuestMediaSession.hostReceiptsKey),
        <String>[host.submissionId!],
      );
      await host.withdraw();
      expect(host.submissionId, isNull);
      expect(prefs.getStringList(GuestMediaSession.hostReceiptsKey), isEmpty);
      expect(
        prefs.getStringList(GuestMediaSession.receiptsKey),
        <String>[guest.submissionId!],
      );
      await dir.delete(recursive: true);
    },
  );
}
