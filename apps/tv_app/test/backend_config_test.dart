import 'dart:io';

import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kernel_app/kernel_app.dart';
import 'package:tv_app/src/bootstrap/playback_dependencies.dart';
import 'package:tv_app/src/config/backend_config.dart';

import 'support/fakes.dart';
import 'package:tv_app/src/wall/wall_boot.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('defaults to offline and keeps partial live config disabled', () {
    final BackendConfig offline = BackendConfig.parse(const <String, String>{});
    expect(offline.mode, BackendMode.offline);
    expect(offline.isLiveConfigured, isFalse);
    expect(offline.functionsRegion, 'us-central1');

    final BackendConfig partial = BackendConfig.parse(const <String, String>{
      'BACKEND_MODE': 'firebase',
      'TV_PARTY_ID': 'party-1',
    });
    expect(partial.isLiveRequested, isTrue);
    expect(partial.isLiveConfigured, isFalse);
    expect(partial.error, contains('TV_DEVICE_ID'));
  });

  test('accepts provisioned emulator client options and configured region', () {
    final BackendConfig config = BackendConfig.parse(const <String, String>{
      'BACKEND_MODE': 'emulator',
      'TV_PARTY_ID': 'party-1',
      'TV_DEVICE_ID': 'tv-room-1',
      'FUNCTIONS_REGION': 'northamerica-northeast1',
      'FIREBASE_PROJECT_ID': 'demo-haunted-tv',
      'FIREBASE_APP_ID': '1:123:web:abc',
      'FIREBASE_API_KEY': 'client-placeholder',
      'FIREBASE_MESSAGING_SENDER_ID': '123',
      'FIRESTORE_EMULATOR_HOST': '127.0.0.1',
      'FIRESTORE_EMULATOR_PORT': '8080',
      'FUNCTIONS_EMULATOR_HOST': '127.0.0.1',
      'FUNCTIONS_EMULATOR_PORT': '5001',
    });

    expect(config.isLiveConfigured, isTrue, reason: config.error);
    expect(config.useEmulator, isTrue);
    expect(config.functionsRegion, 'northamerica-northeast1');
    expect(config.firebaseOptions?.projectId, 'demo-haunted-tv');
  });

  test(
    'configuration-disabled composition boots offline without Firebase init',
    () async {
      final Directory root = await Directory.systemTemp.createTemp(
        'tv-config-test-',
      );
      addTearDown(() => root.delete(recursive: true));
      var firebaseInitializations = 0;
      final PlaybackDependencies dependencies =
          await PlaybackDependencies.create(
            config: BackendConfig.parse(const <String, String>{}),
            supportDirectory: Directory('${root.path}/support'),
            stagingDirectory: Directory('${root.path}/temporary'),
            firebaseBootstrap: (_) async {
              firebaseInitializations++;
            },
          );

      final List<List<int>> bytes = <List<int>>[
        <int>[1, 2, 3, 4],
        <int>[5, 6, 7, 8],
        <int>[9, 10, 11, 12],
        <int>[13, 14, 15, 16],
      ];
      final PlaybackManifest fixture = PlaybackManifest(
        partyId: 'local-party',
        channelId: 'haunted_surveillance',
        version: 1,
        clips: <ClipDescriptor>[
          for (var index = 0; index < bytes.length; index++)
            ClipDescriptor(
              id: 'clip-0${index + 1}',
              cameraId: 'CAM-0${index + 1}',
              storageObjectId: 'assets/cam0${index + 1}.mp4',
              sha256: sha256Hex(bytes[index]),
              sizeBytes: bytes[index].length,
              duration: const Duration(seconds: 2),
              mimeType: 'video/mp4',
            ),
        ],
        publishedAt: DateTime.utc(2026, 10, 29),
      );
      final WallBoot boot = WallBoot(
        store: InMemoryManifestStore(),
        preparePlayback: dependencies.preparePlayback,
        fixture: ({required String partyId, required String channelId}) =>
            fixture,
        assetBytesLoader: (String path) async =>
            bytes[int.parse(path.substring(11, 12)) - 1],
        bundleLoader: (_) async => throw StateError('unused fixture loader'),
      );

      final WallBootResult result = await boot.boot();
      expect(result.isReady, isTrue, reason: result.unavailableReason);
      expect(
        result.mediaByClipId,
        isEmpty,
        reason: 'bundled media stays in the asset namespace',
      );
      expect(dependencies.liveSession, isNull);
      expect(firebaseInitializations, 0);
      expect(
        dependencies.preparePlayback.snapshot.state,
        PlaybackSyncState.errorRecoverable,
        reason: 'boot checks the durable index before the verified bundle',
      );
    },
  );
}
