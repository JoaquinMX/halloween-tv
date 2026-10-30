// BackendConfig parsing: default offline boot, file shapes, and the
// never-silently-cloud rule. Pure Dart, no Firebase initialization.

import 'dart:convert';
import 'dart:io';

import 'package:companion_app/src/config/backend_config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('BackendConfig default boot', () {
    test('empty options boot unconfigured without Firebase', () {
      final BackendConfig config = BackendConfig.parse(<String, Object?>{});

      expect(config.mode, CompanionBackendMode.unconfigured);
      expect(config.isLiveConfigured, isFalse);
      expect(config.useEmulator, isFalse);
      expect(config.error, isNull);
      expect(config.firebaseOptions, isNull);
    });

    test('unconfigured factory carries no cloud target', () {
      final BackendConfig config = BackendConfig.unconfigured();

      expect(config.isLiveConfigured, isFalse);
      expect(config.firebaseOptions, isNull);
    });

    test('malformed JSON resolves to recoverable unconfigured state', () {
      final BackendConfig config = BackendConfig.parseJson('{nope');

      expect(config.mode, CompanionBackendMode.unconfigured);
      expect(config.isLiveConfigured, isFalse);
      expect(config.firebaseOptions, isNull);
      expect(config.error, isNotNull);
    });
  });

  group('BackendConfig live parsing', () {
    Map<String, Object?> live() => <String, Object?>{
      'apiKey': 'test-api-key',
      'appId': '1:123:android:abc',
      'projectId': 'test-project',
    };

    test('complete options select the firebase target', () {
      final BackendConfig config = BackendConfig.parse(live());

      expect(config.mode, CompanionBackendMode.firebase);
      expect(config.isLiveConfigured, isTrue);
      expect(config.functionsRegion, 'us-central1');
      expect(config.firebaseOptions, isNotNull);
      expect(config.firebaseOptions!.projectId, 'test-project');
      expect(config.firebaseOptions!.appId, '1:123:android:abc');
      expect(config.firebaseOptions!.apiKey, 'test-api-key');
    });

    test('custom region is preserved; blank region falls back', () {
      final BackendConfig eu = BackendConfig.parse(<String, Object?>{
        ...live(),
        'functionsRegion': 'europe-west1',
      });
      expect(eu.functionsRegion, 'europe-west1');
      expect(eu.isLiveConfigured, isTrue);

      final BackendConfig fallback = BackendConfig.parse(live());
      expect(fallback.functionsRegion, 'us-central1');
    });

    test('partial options never silently select a cloud target', () {
      final BackendConfig config = BackendConfig.parse(<String, Object?>{
        'projectId': 'test-project',
      });

      expect(config.mode, CompanionBackendMode.unconfigured);
      expect(config.isLiveConfigured, isFalse);
      expect(config.firebaseOptions, isNull);
      expect(config.error, contains('incomplete'));
    });

    test('invalid region is a recoverable configuration error', () {
      final BackendConfig config = BackendConfig.parse(<String, Object?>{
        ...live(),
        'functionsRegion': 'us/central1',
      });

      expect(config.isLiveConfigured, isFalse);
      expect(config.firebaseOptions, isNull);
      expect(config.error, contains('functionsRegion'));
    });

    test('emulator needs a valid host and port', () {
      final BackendConfig missing = BackendConfig.parse(<String, Object?>{
        ...live(),
        'functionsEmulatorHost': 'localhost',
      });
      expect(missing.isLiveConfigured, isFalse);
      expect(missing.error, contains('emulator'));

      final BackendConfig valid = BackendConfig.parse(<String, Object?>{
        ...live(),
        'functionsEmulatorHost': 'localhost',
        'functionsEmulatorPort': 5001,
      });
      expect(valid.mode, CompanionBackendMode.emulator);
      expect(valid.useEmulator, isTrue);
      expect(valid.isLiveConfigured, isTrue);
      expect(valid.functionsEmulatorPort, 5001);
    });

    test('parseJson round-trips a live options file', () {
      final BackendConfig config = BackendConfig.parseJson(
        jsonEncode(<String, Object?>{
          ...live(),
          'functionsRegion': 'asia-southeast1',
        }),
      );

      expect(config.isLiveConfigured, isTrue);
      expect(config.functionsRegion, 'asia-southeast1');
    });
  });

  group('firebase.example.json', () {
    test('holds placeholders only and parses structurally', () async {
      final String source = await File(
        'config/firebase.example.json',
      ).readAsString();
      final Map<String, Object?> json = Map<String, Object?>.from(
        jsonDecode(source) as Map<Object?, Object?>,
      );

      expect(json['projectId'], 'YOUR-FIREBASE-PROJECT-ID');
      expect(json['appId'], 'YOUR-FIREBASE-APP-ID');
      expect(json['apiKey'], 'YOUR-FIREBASE-API-KEY');
      // No real secret material: every required value is a YOUR- sentinel.
      for (final String key in <String>['projectId', 'appId', 'apiKey']) {
        expect(
          (json[key]! as String).startsWith('YOUR-'),
          isTrue,
          reason: '$key must be a placeholder',
        );
      }

      final BackendConfig config = BackendConfig.parse(json);
      expect(config.error, isNull);
      expect(config.functionsRegion, 'us-central1');
    });
  });
}
