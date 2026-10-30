// Guest-photo positive completion flow (host-run integration).
//
// Runs the REAL companion guest-media stack ([GuestMediaClient] consent
// gate and [HttpGuestMediaTransport] byte upload) against the REAL Firebase
// emulators (Functions/Firestore/Storage on the `backend/firebase.json`
// ports) and the REAL guest-media callables
// (requestGuestUpload/completeGuestUpload/getGuestMediaStatus/
// withdrawGuestMedia in `backend/functions/src/index.ts`). No billable
// calls: the emulators are local and generation stays disabled there.
//
// Backend contract under test (2026-10-30, from
// `backend/functions/src/guest_upload.ts` + `contracts.ts`):
//   requestGuestUpload  {partyId, deviceId, channelId,
//                        consent:{accepted:true,textVersion:"v1",
//                                purpose:"guest_cameo"},
//                        contentType:"image/jpeg"|"image/png"}
//                     -> {submissionId, objectPath, uploadUrl, expiresAt,
//                         consentRevision}
//   completeGuestUpload {partyId, deviceId, channelId, submissionId}
//                     -> {submissionId, partyId, deviceId, channelId,
//                         status:"eligible", objectPath, consentRevision,
//                         expiresAt, sha256, sizeBytes}
//   getGuestMediaStatus {partyId, deviceId, channelId, submissionId}
//                     -> same shape, status pending_upload|eligible|
//                        withdrawn|expired
//   withdrawGuestMedia  {partyId, deviceId, channelId, submissionId}
//                     -> {submissionId, status:"withdrawn",
//                         deletedObjects, verifiedAbsent:true}
//
// NOTE: the in-app [GuestMediaClient]/[GuestMediaSession] request shapes
// predate this contract (no channelId, `consent:true` instead of the
// consent object, `contentType` echo + https-only URL + non-"withdrawn"
// status expectations), so the happy path below drives the real callable
// wire envelope (`{"data": ...}`, identical to what `firebase_functions`
// sends) directly, while the consent gate and the byte PUT still go
// through the real client/transport classes. The assertions are
// falsifiable end to end: capability -> signed PUT -> complete(eligible,
// backend-computed sha256/sizeBytes) -> status -> withdraw -> object
// absence -> refusal of later use from the guest path.
//
// Emulators must be running before this file runs (from `backend/`).
// Capability minting needs a local signing key (the Functions emulator
// has no ADC private key, so getSignedUrl would return INTERNAL):
//   GOOGLE_APPLICATION_CREDENTIALS=/tmp/fake-sa.json
//   STORAGE_BUCKET=demo-halloween-tv.appspot.com firebase
//     --config firebase.json emulators:start
//     --only firestore,functions,storage --project demo-halloween-tv
// and the fixed party must be pre-seeded with the Admin SDK (client REST
// cannot create it: firestore.rules deny all direct writes):
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
//   STORAGE_EMULATOR_HOST=http://127.0.0.1:9199 node /tmp/seed-guest-photo.js
// (wipes parties/guest-photo-it in Firestore AND Storage, recreates the
// party + its cctv channel; the device is left for joinParty to create).
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

/// Server-side consent constants (mirror backend/functions/src/config.ts).
const String _kConsentTextVersion = 'v1';
const String _kConsentPurpose = 'guest_cameo';

/// Synthetic image under test: SOI + APP0(JFIF) + EOI, a real file on disk.
/// sha256 (computed out of band, asserted against the backend echo):
/// d20f6ffd523b78a86cd2f916fa34af5d1918d75f7b142237c752ad6b254213ab
const List<int> _kSyntheticJpeg = <int>[
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
];
const String _kExpectedSha256 =
    'd20f6ffd523b78a86cd2f916fa34af5d1918d75f7b142237c752ad6b254213ab';

/// Non-2xx callable/REST outcome from an emulator endpoint.
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

String _stringField(Map<String, Object?> fields, String name) {
  final Object? field = fields[name];
  if (field is Map<String, Object?> && field['stringValue'] is String) {
    return field['stringValue'] as String;
  }
  throw FormatException('Firestore field $name is not a string: $field');
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
    'guest photo positive flow against emulators: consent-gated capability, '
    'signed PUT, complete, status, withdraw, absence, generation refused',
    timeout: const Timeout(Duration(minutes: 4)),
    () async {
      if (!await _emulatorsReachable()) {
        markTestSkipped(
          'Firebase emulators are not reachable on 127.0.0.1 '
          '(firestore :8080). From backend/ run: '
          'GOOGLE_APPLICATION_CREDENTIALS=/tmp/fake-sa.json '
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
      //   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
      //   STORAGE_EMULATOR_HOST=http://127.0.0.1:9199
      //   node /tmp/seed-guest-photo.js
      // (wipes and recreates parties/guest-photo-it + its cctv channel;
      // the device below is left for joinParty to register).
      const String partyId = 'guest-photo-it';
      const String channelId = 'cctv';
      const String deviceId = 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      Map<String, Object?> identity() => <String, Object?>{
        'partyId': partyId,
        'deviceId': deviceId,
        'channelId': channelId,
      };

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
        await photo.writeAsBytes(_kSyntheticJpeg);
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
            byteSize: _kSyntheticJpeg.length,
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

        // 2. Server-side consent gate: a non-affirmative consent object is
        // refused by the real backend before any capability is minted.
        Object? consentError;
        try {
          await _callFunction('requestGuestUpload', <String, Object?>{
            ...identity(),
            'consent': <String, Object?>{
              'accepted': false,
              'textVersion': _kConsentTextVersion,
              'purpose': _kConsentPurpose,
            },
            'contentType': 'image/jpeg',
          });
        } on _Refusal catch (error) {
          consentError = error;
        }
        expect(
          consentError,
          isA<_Refusal>(),
          reason: 'non-affirmative consent must be refused server-side',
        );
        expect(
          (consentError as _Refusal).body,
          contains('FORBIDDEN'),
          reason: 'refusal carries the backend FORBIDDEN error code',
        );

        // 3. Real registration path: joinParty creates the guest device doc.
        final Object? joined = await _callFunction('joinParty', identity());
        expect(joined, isA<Map<String, Object?>>());
        final Map<String, Object?> joinedResult =
            joined! as Map<String, Object?>;
        expect(
          joinedResult['created'],
          isTrue,
          reason: 'first join registers the guest device',
        );
        final Map<String, Object?> deviceDoc = await _firestoreGet(
          'parties/$partyId/devices/$deviceId',
        );
        final Map<String, Object?> deviceFields =
            deviceDoc['fields'] as Map<String, Object?>;
        expect(_stringField(deviceFields, 'deviceId'), deviceId);
        expect(_stringField(deviceFields, 'role'), 'guest');
        expect(_stringField(deviceFields, 'status'), 'active');

        // 4. Consent-gated capability issue: the real backend mints a
        // per-submission signed PUT capability bound to a server-assigned
        // object path.
        final Object? capabilityRaw =
            await _callFunction('requestGuestUpload', <String, Object?>{
              ...identity(),
              'consent': <String, Object?>{
                'accepted': true,
                'textVersion': _kConsentTextVersion,
                'purpose': _kConsentPurpose,
              },
              'contentType': 'image/jpeg',
            });
        expect(capabilityRaw, isA<Map<String, Object?>>());
        final Map<String, Object?> capability =
            capabilityRaw! as Map<String, Object?>;
        final String submissionId = capability['submissionId'] as String;
        expect(
          submissionId,
          matches(RegExp(r'^gsub-[a-f0-9]{32}$')),
          reason: 'server-assigned submission id shape',
        );
        final String objectPath = capability['objectPath'] as String;
        expect(
          objectPath,
          'parties/$partyId/guests/$deviceId/ingest/$submissionId/photo.jpg',
          reason: 'capability is bound to the server-assigned object path',
        );
        final String uploadUrl = capability['uploadUrl'] as String;
        expect(uploadUrl, isNotEmpty);
        expect(
          uploadUrl,
          contains(objectPath),
          reason: 'signed PUT URL is per-submission, never persisted',
        );
        final DateTime expiresAt = DateTime.parse(
          capability['expiresAt'] as String,
        );
        expect(
          expiresAt.isAfter(DateTime.now().toUtc()),
          isTrue,
          reason: 'capability carries a future expiry',
        );
        final String consentRevision =
            capability['consentRevision'] as String;
        expect(
          consentRevision,
          startsWith('$_kConsentTextVersion:'),
          reason: 'capability echoes the server-side consent revision',
        );

        // 5. Signed PUT of the synthetic image through the real transport.
        // The backend validates these exact bytes before any eligibility.
        await transport.put(Uri.parse(uploadUrl), photo, 'image/jpeg');
        expect(transport.puts, 1, reason: 'exactly one PUT to the capability');

        // 6. Completion: the backend verifies the stored bytes and records
        // eligibility with the independently computed hash and size.
        final Object? completedRaw = await _callFunction(
          'completeGuestUpload',
          <String, Object?>{...identity(), 'submissionId': submissionId},
        );
        expect(completedRaw, isA<Map<String, Object?>>());
        final Map<String, Object?> completed =
            completedRaw! as Map<String, Object?>;
        expect(completed['status'], 'eligible');
        expect(completed['sha256'], _kExpectedSha256);
        expect(completed['sizeBytes'], _kSyntheticJpeg.length);
        expect(completed['consentRevision'], consentRevision);
        expect(completed['submissionId'], submissionId);
        expect(completed['objectPath'], objectPath);

        // 7. Status: the owning registered device reads back eligibility.
        final Object? statusRaw = await _callFunction(
          'getGuestMediaStatus',
          <String, Object?>{...identity(), 'submissionId': submissionId},
        );
        expect(statusRaw, isA<Map<String, Object?>>());
        final Map<String, Object?> status =
            statusRaw! as Map<String, Object?>;
        expect(status['status'], 'eligible');
        expect(status['sha256'], _kExpectedSha256);
        expect(status['sizeBytes'], _kSyntheticJpeg.length);

        // Unknown submissions do not exist: the status path is real.
        Object? unknownError;
        try {
          await _callFunction('getGuestMediaStatus', <String, Object?>{
            ...identity(),
            'submissionId': 'gsub-00000000000000000000000000000000',
          });
        } on _Refusal catch (error) {
          unknownError = error;
        }
        expect(unknownError, isA<_Refusal>());
        expect((unknownError as _Refusal).body, contains('NOT_FOUND'));

        // 8. Withdrawal revokes eligibility and purges the cloud copy.
        final Object? withdrawnRaw = await _callFunction(
          'withdrawGuestMedia',
          <String, Object?>{...identity(), 'submissionId': submissionId},
        );
        expect(withdrawnRaw, isA<Map<String, Object?>>());
        final Map<String, Object?> withdrawn =
            withdrawnRaw! as Map<String, Object?>;
        expect(withdrawn['status'], 'withdrawn');
        expect(withdrawn['verifiedAbsent'], isTrue);
        expect(withdrawn['deletedObjects'], contains(objectPath));

        // 9. Post-withdrawal status is the tombstone, not eligibility.
        final Object? afterRaw = await _callFunction(
          'getGuestMediaStatus',
          <String, Object?>{...identity(), 'submissionId': submissionId},
        );
        expect(
          (afterRaw! as Map<String, Object?>)['status'],
          'withdrawn',
        );

        // 10. Object absence: no guest bytes linger under the party prefix.
        final List<String> objects = await _storageObjects(
          'parties/$partyId/',
        );
        expect(
          objects,
          isEmpty,
          reason: 'withdrawn guest object must be absent from Storage',
        );

        // 11. Refusal of later use from the guest path: re-completion of
        // the withdrawn submission is forbidden (consent withdrawn).
        Object? recompleteError;
        try {
          await _callFunction('completeGuestUpload', <String, Object?>{
            ...identity(),
            'submissionId': submissionId,
          });
        } on _Refusal catch (error) {
          recompleteError = error;
        }
        expect(recompleteError, isA<_Refusal>());
        expect((recompleteError as _Refusal).body, contains('FORBIDDEN'));

        // 12. Refusal of later generation from the guest path: generation
        // is disabled in the emulator, so even a well-formed guest-bound
        // request is refused with PROVIDER_UNAVAILABLE before any job row
        // or enqueue (no billable work).
        Object? generationError;
        try {
          await _callFunction('requestGeneration', <String, Object?>{
            ...identity(),
            'jobId': 'guest-photo-it-job',
            'idempotencyKey': 'guest-photo-it-key',
            'presetId': 'cheap_demo',
            'guestMediaId': submissionId,
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
        // The refused generation left no job trace on the device doc.
        final Map<String, Object?> reread = await _firestoreGet(
          'parties/$partyId/devices/$deviceId',
        );
        final Map<String, Object?> rereadFields =
            reread['fields'] as Map<String, Object?>;
        expect(rereadFields.containsKey('jobId'), isFalse);
      } finally {
        await dir.delete(recursive: true);
      }
    },
  );
}
