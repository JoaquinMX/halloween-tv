// Guest-photo emulator contract test (host-run integration).
//
// Runs the REAL companion guest-media stack ([GuestMediaClient],
// [GuestMediaSession], and [HttpGuestMediaTransport]) against the REAL
// Firebase emulators (Functions/Firestore/Storage on the
// `backend/firebase.json` ports). No billable calls: the emulators are
// local, generation stays disabled there, and the guest-media callables are
// not implemented server-side (see below).
//
// Backend reality (pinned, 2026-10-30): `backend/functions/src/index.ts`
// exports requestGeneration, runGeneration, getDeliveryUrls,
// getCurrentManifest, acknowledgeDelivery, listPartyDevices, joinParty and
// sweepExpiredMedia — there are NO requestGuestUpload/completeGuestUpload/
// getGuestMediaStatus/withdrawGuestMedia handlers. This test therefore pins
// the REFUSAL contract: a consented guest upload attempt is refused by the
// Functions emulator (no capability, no transport use, no receipt), the
// withdrawn/absent image has no stored object, and generation cannot be
// triggered from the guest path. When the backend ships guest-media
// callables, the refusal assertions below must be replaced by the positive
// completion flow (capability -> PUT -> complete -> status -> withdraw ->
// object absence); the assertions are falsifiable either way.
//
// Emulators must be running before this file runs (from `backend/`):
//   STORAGE_BUCKET=demo-halloween-tv.appspot.com firebase
//     --config firebase.json emulators:start
//     --only firestore,functions,storage --project demo-halloween-tv
// and the fixed party must be pre-seeded with the Admin SDK (client REST
// cannot create it: firestore.rules deny all direct writes):
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node /tmp/seed-guest-photo.js
// (wipes and recreates parties/guest-photo-it + its cctv channel).
// If the emulators are unreachable the test SKIPS (never fake-passes).
//
// Run serially from `apps/companion_app`:
//   flutter test --concurrency=1 integration_test/guest_photo_emulator_test.dart
library;

import 'dart:convert';
import 'dart:io';

import 'package:companion_app/src/data/guest_media_client.dart';
import 'package:companion_app/src/session/guest_media_session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

const String _kProject = 'demo-halloween-tv';
const String _kRegion = 'us-central1';
const String _kFunctionsBase = 'http://127.0.0.1:5001';
const String _kFirestoreBase = 'http://127.0.0.1:8080';
const String _kStorageBase = 'http://127.0.0.1:9199';
const String _kBucket = 'demo-halloween-tv.appspot.com';
const Duration _kHttpTimeout = Duration(seconds: 20);

/// Non-200 callable/REST outcome from an emulator endpoint.
final class _Refusal implements Exception {
  const _Refusal(this.status, this.body);
  final int status;
  final String body;

  @override
  String toString() => 'emulator refused (HTTP $status): $body';
}

/// Speaks the real callable wire envelope (`{"data": ...}`) to the Functions
/// emulator over HTTP. The `firebase_functions` MethodChannel has no host
/// implementation under `flutter test`, so the emulator is driven through
/// `package:http` with the identical request/response format instead.
Future<Object?> _callFunction(
  String name,
  Map<String, Object?> data,
) async {
  final Uri uri = Uri.parse('$_kFunctionsBase/$_kProject/$_kRegion/$name');
  final http.Response response = await http
      .post(
        uri,
        headers: <String, String>{'Content-Type': 'application/json'},
        body: jsonEncode(<String, Object?>{'data': data}),
      )
      .timeout(_kHttpTimeout);
  if (response.statusCode != 200) {
    throw _Refusal(response.statusCode, response.body);
  }
  final Object? decoded = jsonDecode(response.body);
  if (decoded is Map<String, Object?> && decoded.containsKey('result')) {
    return decoded['result'];
  }
  return decoded;
}

/// [GuestMediaCallableInvoker] over the Functions emulator callable envelope.
final class _EmulatorInvoker implements GuestMediaCallableInvoker {
  _EmulatorInvoker(this._call);
  final Future<Object?> Function(
    String name,
    Map<String, Object?> payload,
  ) _call;
  int calls = 0;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    calls++;
    return _call(name, payload);
  }
}

/// Counts transport use while delegating to the real [HttpGuestMediaTransport].
final class _CountingTransport implements GuestMediaTransport {
  _CountingTransport(this._inner);
  final HttpGuestMediaTransport _inner;
  int puts = 0;

  @override
  Future<void> put(Uri uri, File file, String contentType) async {
    puts++;
    await _inner.put(uri, file, contentType);
  }
}

Future<bool> _emulatorsReachable() async {
  try {
    final http.Response response = await http
        .get(
          Uri.parse(
            '$_kFirestoreBase/v1/projects/$_kProject/'
            'databases/(default)/documents/parties/probe-readiness-check',
          ),
        )
        .timeout(const Duration(seconds: 5));
    // 403 (rules-deny on direct reads) or 404 both prove a live emulator.
    return response.statusCode == 403 || response.statusCode == 404;
  } on Object {
    return false;
  }
}

Future<Map<String, Object?>> _firestoreGet(String documentPath) async {
  final http.Response response = await http
      .get(
        Uri.parse(
          '$_kFirestoreBase/v1/projects/$_kProject/'
          'databases/(default)/documents/$documentPath',
        ),
      )
      .timeout(_kHttpTimeout);
  if (response.statusCode != 200) {
    throw _Refusal(response.statusCode, response.body);
  }
  final Object? decoded = jsonDecode(response.body);
  if (decoded is! Map<String, Object?>) {
    throw const FormatException('Firestore document is not a JSON object');
  }
  return decoded;
}

/// Storage emulator object names under [prefix] (empty when absent).
Future<List<String>> _storageObjects(String prefix) async {
  final http.Response response = await http
      .get(
        Uri.parse(
          '$_kStorageBase/storage/v1/b/$_kBucket/o'
          '?prefix=${Uri.encodeComponent(prefix)}',
        ),
      )
      .timeout(_kHttpTimeout);
  if (response.statusCode == 404) {
    // Bucket (or prefix root) does not exist: nothing stored.
    return <String>[];
  }
  if (response.statusCode != 200) {
    throw _Refusal(response.statusCode, response.body);
  }
  final Object? decoded = jsonDecode(response.body);
  if (decoded is! Map<String, Object?>) {
    throw const FormatException('Storage listing is not a JSON object');
  }
  final Object? items = decoded['items'];
  if (items == null) {
    return <String>[];
  }
  if (items is! List<Object?>) {
    throw const FormatException('Storage listing items is not a list');
  }
  final List<String> names = <String>[];
  for (final Object? item in items) {
    if (item is Map<String, Object?> && item['name'] is String) {
      names.add(item['name'] as String);
    }
  }
  return names;
}

void main() {
  test(
    'guest photo against emulators: consent-gated, refused without '
    'backend callables, nothing stored, generation refused',
    timeout: const Timeout(Duration(minutes: 4)),
    () async {
      if (!await _emulatorsReachable()) {
        markTestSkipped(
          'Firebase emulators are not reachable on 127.0.0.1 '
          '(firestore :8080). From backend/ run: '
          'STORAGE_BUCKET=demo-halloween-tv.appspot.com firebase '
          '--config firebase.json emulators:start '
          '--only firestore,functions,storage '
          '--project demo-halloween-tv',
        );
      }

      SharedPreferences.setMockInitialValues(<String, Object>{});
      final SharedPreferences prefs = await SharedPreferences.getInstance();

      // Fixed party pre-seeded with the Admin SDK (client REST cannot
      // create it: rules deny all direct writes). Pre-seed with:
      //   node /tmp/seed-guest-photo.js (FIRESTORE_EMULATOR_HOST set).
      const String partyId = 'guest-photo-it';
      const String channelId = 'cctv';
      final String deviceId = 'p-${'a' * 31}';

      // Real registration path: joinParty creates the guest device doc.
      final Object? joined = await _callFunction('joinParty', <String, Object?>{
        'partyId': partyId,
        'deviceId': deviceId,
        'channelId': channelId,
      });
      expect(joined, isA<Map<String, Object?>>());
      final Map<String, Object?> joinedResult = joined! as Map<String, Object?>;
      expect(
        joinedResult['created'],
        isTrue,
        reason: 'first join registers the guest device',
      );
      final Map<String, Object?> deviceDoc = await _firestoreGet(
        'parties/$partyId/devices/$deviceId',
      );
      final Object? deviceFields = deviceDoc['fields'];
      expect(deviceFields, isA<Map<String, Object?>>());

      final _EmulatorInvoker invoker = _EmulatorInvoker(_callFunction);
      final _CountingTransport transport = _CountingTransport(
        HttpGuestMediaTransport(),
      );
      final GuestMediaClient client = GuestMediaClient(
        invoker: invoker,
        transport: transport,
      );
      final Directory dir = await Directory.systemTemp.createTemp(
        'guest-photo-it-',
      );
      try {
        // Synthetic image: minimal JPEG container bytes, real file on disk.
        final File photo = File('${dir.path}/synthetic.jpg');
        await photo.writeAsBytes(<int>[0xFF, 0xD8, 0xFF, 0xD9]);
        final GuestMediaSession session = GuestMediaSession(
          client: client,
          partyId: partyId,
          deviceId: deviceId,
          preferences: () async => prefs,
          tempDirectory: () async => dir,
        );

        // 1. Consent gate holds before any network: no capability call.
        await expectLater(
          client.requestUpload(
            partyId: partyId,
            deviceId: deviceId,
            contentType: 'image/jpeg',
            byteSize: 4,
            affirmativeConsent: false,
          ),
          throwsStateError,
        );
        expect(invoker.calls, 0, reason: 'refused before the network');
        await expectLater(
          session.submit(photo, consent: false, confirmed: true),
          throwsStateError,
        );
        expect(invoker.calls, 0, reason: 'refused before the network');

        // 2. Consented attempt reaches the Functions emulator, which has no
        // guest-media callables: refusal (HTTP 404, no such function),
        // no upload, no receipt.
        Object? capabilityError;
        try {
          await session.submit(photo, consent: true, confirmed: true);
        } on _Refusal catch (error) {
          capabilityError = error;
        }
        expect(
          capabilityError,
          isA<_Refusal>(),
          reason: 'unimplemented guest capability must be refused',
        );
        final _Refusal refusedCapability = capabilityError! as _Refusal;
        expect(
          refusedCapability.status,
          404,
          reason: 'no requestGuestUpload handler is deployed',
        );
        expect(
          refusedCapability.body,
          contains('does not exist'),
        );
        expect(invoker.calls, 1, reason: 'exactly one capability attempt');
        expect(transport.puts, 0, reason: 'no bytes uploaded without a URL');
        expect(
          prefs.getString(GuestMediaSession.receiptKey),
          isNull,
          reason: 'no consent receipt persisted without a capability',
        );

        // 3. Withdrawal with nothing submitted is a local no-op; the
        // withdrawal/status callables do not exist either (HTTP 404).
        await session.withdraw();
        expect(invoker.calls, 1, reason: 'withdrawal without a receipt is local');
        Object? withdrawError;
        try {
          await client.withdraw(
            partyId: partyId,
            deviceId: deviceId,
            submissionId: 'submission_nope_123',
          );
        } on _Refusal catch (error) {
          withdrawError = error;
        }
        expect(withdrawError, isA<_Refusal>());
        expect((withdrawError as _Refusal).status, 404);
        await expectLater(
          client.status(
            partyId: partyId,
            deviceId: deviceId,
            submissionId: 'submission_nope_123',
          ),
          throwsA(isA<_Refusal>()),
        );

        // 4. Object absence: no guest bytes under the party prefix.
        final List<String> objects = await _storageObjects(
          'parties/$partyId/',
        );
        expect(
          objects,
          isEmpty,
          reason: 'no guest object may linger in Storage',
        );

        // 5. No consent/media record in Firestore: the device doc the
        // join created carries no guest-photo fields. (Collection lists
        // are rules-denied for clients, so the doc read is the check.)
        final Map<String, Object?> reread = await _firestoreGet(
          'parties/$partyId/devices/$deviceId',
        );
        final Map<String, Object?> fields =
            reread['fields'] as Map<String, Object?>;
        expect(fields.containsKey('consent'), isFalse);
        expect(fields.containsKey('submissionId'), isFalse);

        // 6. Refusal of later generation from the guest path: generation
        // is disabled in the emulator, so even a well-formed request is
        // refused with PROVIDER_UNAVAILABLE before any job row or enqueue
        // (no billable work). A guest-photo-flavored preset would
        // additionally fail INVALID_ARGUMENT validation when enabled.
        // no job row, no billable work.)
        Object? generationError;
        try {
          await _callFunction('requestGeneration', <String, Object?>{
            'partyId': partyId,
            'deviceId': deviceId,
            'channelId': channelId,
            'jobId': 'guest-photo-it-job',
            'idempotencyKey': 'guest-photo-it-key',
            'presetId': 'guest-photo-v1',
          });
        } on _Refusal catch (error) {
          generationError = error;
        }
        expect(
          generationError,
          isA<_Refusal>(),
          reason: 'guest-keyed generation must be refused',
        );
        expect(
          (generationError as _Refusal).body,
          contains('PROVIDER_UNAVAILABLE'),
          reason: 'generation stays disabled; nothing enqueued, no spend',
        );
        // The refused generation left no trace on the device doc.
        final Map<String, Object?> after = await _firestoreGet(
          'parties/$partyId/devices/$deviceId',
        );
        final Map<String, Object?> afterFields =
            after['fields'] as Map<String, Object?>;
        expect(afterFields.containsKey('jobId'), isFalse);
      } finally {
        await dir.delete(recursive: true);
      }
    },
  );
}
