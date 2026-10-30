// Read-only callable composition: exact payload, real transport-to-mapper
// output from the backend contract vector, timestamp preservation,
// malformed/schema/scope/camera rejection, and error classification.
//
// Only the external callable boundary is substituted (fake
// FirebaseManifestCallableInvoker / invoker handler seam); every assertion
// runs through the production transport, mapper, validator, and classifier.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/foundation.dart';
import 'package:companion_app/src/bootstrap/companion_dependencies.dart';
import 'package:companion_app/src/config/backend_config.dart';
import 'package:companion_app/src/data/callable_manifest_invoker.dart';
import 'package:companion_app/src/data/manifest_connection.dart';
import 'package:companion_app/src/data/manifest_failure.dart';
import 'package:companion_app/src/data/party_join_client.dart';
import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:core_foundation/core_foundation.dart' show DeviceId, PartyId;
import 'package:core_playlist/core_playlist.dart' show PlaybackManifest;
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_firestore/infra_firestore.dart'
    show
        FirebaseManifestCallableInvoker,
        FirebaseTvIdentity,
        ManifestSchemaException,
        ManifestScopeException,
        ManifestTransportException;

Object? _deep(Object? value) {
  if (value is Map) {
    return <String, Object?>{
      for (final MapEntry<Object?, Object?> entry in value.entries)
        entry.key! as String: _deep(entry.value),
    };
  }
  if (value is List) {
    return <Object?>[for (final Object? item in value) _deep(item)];
  }
  return value;
}

Future<Map<String, Object?>> _contractManifest() async {
  final String source = await File(
    '../../test/fixtures/backend_contract_v1.json',
  ).readAsString();
  final Map<Object?, Object?> fixture =
      jsonDecode(source) as Map<Object?, Object?>;
  final Map<Object?, Object?> section =
      fixture['getCurrentManifest'] as Map<Object?, Object?>;
  return _deep(section['response']) as Map<String, Object?>;
}

/// Deep-decodes JSON maps so nested values keep `Object?` typing.
Map<String, Object?> _deepCopy(Map<String, Object?> source) =>
    _deep(jsonDecode(jsonEncode(source))) as Map<String, Object?>;

final class FakeInvoker implements FirebaseManifestCallableInvoker {
  FakeInvoker({this.result, this.error});

  Object? result;
  Object? error;
  String? lastName;
  Map<String, Object?>? lastPayload;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    lastName = name;
    lastPayload = Map<String, Object?>.of(payload);
    final Object? failure = error;
    if (failure != null) {
      throw failure;
    }
    return result;
  }
}

ManifestConnection _connection(FakeInvoker invoker) => ManifestConnection(
  identity: FirebaseTvIdentity(partyId: 'pilot', deviceId: 'tv-pilot'),
  invoker: invoker,
);

/// Fake joinParty boundary: echoes the requested scope into a valid
/// scoped guest registration so live-boot compositions stay live without
/// Firebase initialization. Never touches manifest payloads.
final class FakePartyJoinInvoker implements PartyJoinCallableInvoker {
  FakePartyJoinInvoker();

  String? lastName;
  Map<String, Object?>? lastPayload;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    lastName = name;
    lastPayload = Map<String, Object?>.of(payload);
    return <String, Object?>{
      'partyId': payload['partyId'],
      'deviceId': payload['deviceId'],
      'channelId': payload['channelId'],
      'role': 'guest',
      'status': 'active',
      'created': true,
    };
  }
}

void main() {
  group('callable payload', () {
    test(
      'invokes getCurrentManifest with exactly party/device/channel',
      skip: kIsWeb ? 'repo fixture files are unreadable on web (dart:io); covered on the VM suite' : false,
      () async {
        final FakeInvoker invoker = FakeInvoker(
          result: await _contractManifest(),
        );

        final PlaybackManifest first = await _connection(
          invoker,
        ).watchCurrent(partyId: 'pilot', channelId: 'main').first;

        expect(first.partyId, 'pilot');
        expect(invoker.lastName, 'getCurrentManifest');
        expect(invoker.lastPayload, <String, Object?>{
          'partyId': 'pilot',
          'deviceId': 'tv-pilot',
          'channelId': 'main',
        });
      },
    );

    test('thin invoker rejects other callables and extra keys', () async {
      Object? captured;
      final CallableManifestInvoker invoker = CallableManifestInvoker.forTest(
        handler: (String name, Map<String, Object?> payload) async {
          captured = payload;
          return <String, Object?>{};
        },
      );

      await expectLater(
        invoker.call('getDeliveryUrls', <String, Object?>{
          'partyId': 'pilot',
          'deviceId': 'tv-pilot',
          'channelId': 'main',
        }),
        throwsArgumentError,
      );
      await expectLater(
        invoker.call('getCurrentManifest', <String, Object?>{
          'partyId': 'pilot',
          'deviceId': 'tv-pilot',
          'channelId': 'main',
          'manifestVersion': 1,
        }),
        throwsArgumentError,
      );

      final Map<String, Object?> document = await invoker.getCurrentManifest(
        partyId: 'pilot',
        deviceId: 'tv-pilot',
        channelId: 'main',
      );
      expect(document, isEmpty);
      expect(captured, <String, Object?>{
        'partyId': 'pilot',
        'deviceId': 'tv-pilot',
        'channelId': 'main',
      });
    });

    test('thin invoker maps a hung callable to a transport timeout', () async {
      final CallableManifestInvoker invoker = CallableManifestInvoker.forTest(
        handler: (String name, Map<String, Object?> payload) =>
            Completer<Object?>().future,
        timeout: const Duration(milliseconds: 20),
      );

      await expectLater(
        invoker.getCurrentManifest(
          partyId: 'pilot',
          deviceId: 'tv-pilot',
          channelId: 'main',
        ),
        throwsA(isA<ManifestTransportException>()),
      );
    });
  });

  group('transport-to-mapper output', skip: kIsWeb ? 'repo fixture files are unreadable on web (dart:io); covered on the VM suite' : false, () {
    test('maps the contract vector to a 4-camera manifest', () async {
      final FakeInvoker invoker = FakeInvoker(
        result: await _contractManifest(),
      );

      final PlaybackManifest manifest = await _connection(
        invoker,
      ).watchCurrent(partyId: 'pilot', channelId: 'main').first;

      expect(manifest.channelId, 'main');
      expect(manifest.version, 1);
      expect(manifest.clips, hasLength(4));
      expect(
        manifest.clips.map((clip) => clip.cameraId).toList(growable: false),
        <String>['CAM-01', 'CAM-02', 'CAM-03', 'CAM-04'],
      );
      expect(
        manifest.clips.first.storageObjectId,
        'parties/pilot/channels/main/delivery/1/CAM-01.mp4',
      );
      expect(
        manifest.clips.first.sha256,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );
      expect(manifest.clips.first.sizeBytes, 12345);
      expect(manifest.clips.first.duration.inMilliseconds, 2000);
      expect(manifest.clips.first.mimeType, 'video/mp4');
    });

    test('preserves the backend publication timestamp', () async {
      final FakeInvoker invoker = FakeInvoker(
        result: await _contractManifest(),
      );

      final PlaybackManifest manifest = await _connection(
        invoker,
      ).watchCurrent(partyId: 'pilot', channelId: 'main').first;

      expect(manifest.publishedAt.toUtc(), DateTime.utc(2026, 10, 29, 14));
    });

    test('malformed payload surfaces ManifestSchemaException', () async {
      final Map<String, Object?> broken = _deepCopy(await _contractManifest())
        ..remove('schemaVersion');
      final FakeInvoker invoker = FakeInvoker(result: broken);

      await expectLater(
        _connection(
          invoker,
        ).watchCurrent(partyId: 'pilot', channelId: 'main').first,
        throwsA(isA<ManifestSchemaException>()),
      );
    });

    test(
      'unsupported schemaVersion surfaces ManifestSchemaException',
      () async {
        final Map<String, Object?> future = _deepCopy(await _contractManifest())
          ..['schemaVersion'] = 2;
        final FakeInvoker invoker = FakeInvoker(result: future);

        await expectLater(
          _connection(
            invoker,
          ).watchCurrent(partyId: 'pilot', channelId: 'main').first,
          throwsA(isA<ManifestSchemaException>()),
        );
      },
    );

    test('out-of-scope document surfaces ManifestScopeException', () async {
      final Map<String, Object?> other = _deepCopy(await _contractManifest())
        ..['partyId'] = 'someone-else';
      final FakeInvoker invoker = FakeInvoker(result: other);

      await expectLater(
        _connection(
          invoker,
        ).watchCurrent(partyId: 'pilot', channelId: 'main').first,
        throwsA(isA<ManifestScopeException>()),
      );
    });

    test('unknown camera surfaces ManifestSchemaException', () async {
      final Map<String, Object?> badCamera = _deepCopy(
        await _contractManifest(),
      );
      final List<Object?> clips = List<Object?>.from(
        badCamera['cameraClips']! as List<Object?>,
      );
      final Map<String, Object?> first = Map<String, Object?>.from(
        clips.first! as Map<String, Object?>,
      )..['cameraId'] = 'CAM-99';
      clips[0] = first;
      badCamera['cameraClips'] = clips;
      final FakeInvoker invoker = FakeInvoker(result: badCamera);

      await expectLater(
        _connection(
          invoker,
        ).watchCurrent(partyId: 'pilot', channelId: 'main').first,
        throwsA(isA<ManifestSchemaException>()),
      );
    });
  });

  group('backend and transport error classification', () {
    FirebaseFunctionsException contractError(
      String code,
      String errorCode,
      String message,
    ) => FirebaseFunctionsException(
      code: code,
      message: message,
      details: <String, Object?>{'errorCode': errorCode},
    );

    test('MANIFEST_MISMATCH classifies by details errorCode, not SDK text', () {
      // The SDK code carries no contract meaning here on purpose: the
      // details errorCode must win.
      final ManifestFailure failure = ManifestFailure.classify(
        const ManifestTransportException(
          'getCurrentManifest callable failed',
          <String, Object?>{'errorCode': 'MANIFEST_MISMATCH'},
        ),
      );

      expect(failure.kind, ManifestFailureKind.malformed);
      expect(failure.retryable, isFalse);
      expect(failure.message, 'The manifest data was invalid.');
    });

    test('real-shaped MANIFEST_MISMATCH exception classifies invalid', () {
      final ManifestFailure failure = ManifestFailure.classify(
        contractError(
          'internal',
          'MANIFEST_MISMATCH',
          'backend said MANIFEST_MISMATCH for secret-party-9',
        ),
      );

      expect(failure.kind, ManifestFailureKind.malformed);
      expect(failure.retryable, isFalse);
      expect(failure.message, isNot(contains('secret-party-9')));
    });

    test('real-shaped CLIP_EXPIRED exception classifies expired', () {
      final ManifestFailure failure = ManifestFailure.classify(
        contractError(
          'internal',
          'CLIP_EXPIRED',
          'clip expired for secret-party-9',
        ),
      );

      expect(failure.kind, ManifestFailureKind.expired);
      expect(failure.retryable, isFalse);
      expect(failure.message, 'This lineup has expired.');
      expect(failure.message, isNot(contains('secret-party-9')));
    });

    test('real-shaped NOT_FOUND exception classifies no-manifest', () {
      final ManifestFailure failure = ManifestFailure.classify(
        contractError(
          'internal',
          'NOT_FOUND',
          'no manifest for secret-party-9',
        ),
      );

      expect(failure.kind, ManifestFailureKind.notFound);
      expect(failure.retryable, isFalse);
      expect(failure.message, 'No manifest is published yet.');
    });

    test('UNAUTHENTICATED renders the provisioning message, never sign-in', () {
      final ManifestFailure failure = ManifestFailure.classify(
        contractError(
          'unauthenticated',
          'UNAUTHENTICATED',
          'missing party/device for secret-party-9',
        ),
      );

      expect(failure.kind, ManifestFailureKind.unauthenticated);
      expect(failure.retryable, isFalse);
      expect(failure.message, 'This device is not provisioned for this party.');
      expect(failure.message, isNot(contains('Sign-in')));
      expect(failure.message, isNot(contains('secret-party-9')));
    });
    test('FORBIDDEN surfaces promptly and classifies without retry', () async {
      final FakeInvoker invoker = FakeInvoker(
        error: const ManifestTransportException(
          'getCurrentManifest callable failed',
          <String, Object?>{'errorCode': 'FORBIDDEN'},
        ),
      );

      Object? failure;
      try {
        await _connection(
          invoker,
        ).watchCurrent(partyId: 'pilot', channelId: 'main').first;
      } catch (error) {
        failure = error;
      }

      expect(failure, isA<ManifestTransportException>());
      final ManifestFailure classified = ManifestFailure.classify(failure!);
      expect(classified.kind, ManifestFailureKind.forbidden);
      expect(classified.retryable, isFalse);
      expect(classified.message, isNotEmpty);
    });

    test(
      'UNAUTHENTICATED and PROVIDER_UNAVAILABLE classify by contract code',
      () {
        final ManifestFailure auth = ManifestFailure.classify(
          const ManifestTransportException(
            'getCurrentManifest callable failed',
            <String, Object?>{'errorCode': 'UNAUTHENTICATED'},
          ),
        );
        expect(auth.kind, ManifestFailureKind.unauthenticated);
        expect(auth.retryable, isFalse);

        final ManifestFailure unavailable = ManifestFailure.classify(
          const ManifestTransportException(
            'getCurrentManifest callable failed',
            <String, Object?>{'errorCode': 'PROVIDER_UNAVAILABLE'},
          ),
        );
        expect(unavailable.kind, ManifestFailureKind.unavailable);
        expect(unavailable.retryable, isTrue);
      },
    );

    test('transport timeout and unknown errors stay sanitized', () {
      final ManifestFailure timeout = ManifestFailure.classify(
        TimeoutException('exceeded', const Duration(seconds: 10)),
      );
      expect(timeout.kind, ManifestFailureKind.timeout);
      expect(timeout.retryable, isTrue);

      final ManifestFailure transport = ManifestFailure.classify(
        StateError('socket reset by peer 10.0.0.9'),
      );
      expect(transport.kind, ManifestFailureKind.transport);
      expect(transport.retryable, isTrue);
      expect(transport.message, isNot(contains('10.0.0.9')));
    });
  });

  group('companion dependencies', () {
    test('default boot is unavailable but recoverable', () async {
      final CompanionDependencies dependencies =
          await CompanionDependencies.create();

      expect(dependencies.isLive, isFalse);
      expect(dependencies.remoteUnavailableReason, isNotNull);
      await expectLater(
        dependencies.manifestSource
            .watchCurrent(partyId: 'pilot', channelId: 'main')
            .first,
        throwsA(isA<ManifestTransportException>()),
      );
    });

    test(
      'init failure resolves to a recoverable configuration state',
      () async {
        final CompanionDependencies dependencies =
            await CompanionDependencies.create(
              config: BackendConfig.parse(<String, Object?>{
                'apiKey': 'test-api-key',
                'appId': '1:123:android:abc',
                'projectId': 'test-project',
              }),
              identity: FirebaseTvIdentity(
                partyId: 'pilot',
                deviceId: 'tv-pilot',
              ),
              firebaseBootstrap: (BackendConfig config) async {
                throw StateError('emulator unreachable');
              },
            );

        expect(dependencies.isLive, isFalse);
        expect(dependencies.remoteUnavailableReason, contains('Firebase'));
      },
    );

    test('configured boot composes the live callable connection', skip: kIsWeb ? 'repo fixture files are unreadable on web (dart:io); covered on the VM suite' : false, () async {
      final FakeInvoker invoker = FakeInvoker(
        result: await _contractManifest(),
      );
      final CompanionDependencies dependencies =
          await CompanionDependencies.create(
            config: BackendConfig.parse(<String, Object?>{
              'apiKey': 'test-api-key',
              'appId': '1:123:android:abc',
              'projectId': 'test-project',
            }),
            identity: FirebaseTvIdentity(
              partyId: 'pilot',
              deviceId: 'tv-pilot',
            ),
            firebaseBootstrap: (BackendConfig config) async {},
            invokerOverride: invoker,
            partyJoinInvokerOverride: FakePartyJoinInvoker(),
          );

      expect(dependencies.isLive, isTrue);
      final PlaybackManifest manifest = await dependencies.manifestSource
          .watchCurrent(partyId: 'pilot', channelId: 'main')
          .first;
      expect(manifest.clips, hasLength(4));
      expect(invoker.lastPayload, <String, Object?>{
        'partyId': 'pilot',
        'deviceId': 'tv-pilot',
        'channelId': 'main',
      });
    });

    test('unscoped live boot scopes each join from guest-typed IDs', skip: kIsWeb ? 'repo fixture files are unreadable on web (dart:io); covered on the VM suite' : false, () async {
      final FakeInvoker invoker = FakeInvoker(
        result: await _contractManifest(),
      );
      final CompanionDependencies dependencies =
          await CompanionDependencies.create(
            config: BackendConfig.parse(<String, Object?>{
              'apiKey': 'test-api-key',
              'appId': '1:123:android:abc',
              'projectId': 'test-project',
            }),
            firebaseBootstrap: (BackendConfig config) async {},
            invokerOverride: invoker,
            partyJoinInvokerOverride: FakePartyJoinInvoker(),
          );

      // Pre-join: live, with no remote problem to banner.
      expect(dependencies.isLive, isTrue);
      expect(dependencies.remoteUnavailableReason, isNull);

      final GuestJoinData join = GuestJoinData(
        partyId: PartyId('pilot'),
        deviceId: DeviceId('guest-phone-7'),
        channelId: 'main',
      );
      final PlaybackManifest manifest = await dependencies
          .manifestSourceForJoin(join)
          .watchCurrent(partyId: 'pilot', channelId: 'main')
          .first;

      expect(manifest.clips, hasLength(4));
      expect(invoker.lastName, 'getCurrentManifest');
      expect(invoker.lastPayload, <String, Object?>{
        'partyId': 'pilot',
        'deviceId': 'guest-phone-7',
        'channelId': 'main',
      });
    });

    test(
      'offline boot has no invoker, so join reuses the base source',
      () async {
        final CompanionDependencies dependencies =
            await CompanionDependencies.create();

        expect(dependencies.isLive, isFalse);
        final GuestJoinData join = GuestJoinData(
          partyId: PartyId('pilot'),
          deviceId: DeviceId('guest-phone-7'),
          channelId: 'main',
        );
        await expectLater(
          dependencies
              .manifestSourceForJoin(join)
              .watchCurrent(partyId: 'pilot', channelId: 'main')
              .first,
          throwsA(isA<ManifestTransportException>()),
        );
      },
    );
  });
}
