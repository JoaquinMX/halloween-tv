/// External, non-secret build configuration for the TV backend.
library;

import 'package:channel_cctv/channel_cctv.dart';
import 'package:firebase_core/firebase_core.dart';

enum BackendMode { offline, firebase, emulator }

/// Parsed Dart define values. Missing or invalid live values disable remote
/// playback while leaving the offline wall configuration valid.
final class BackendConfig {
  const BackendConfig._({
    required this.mode,
    required this.partyId,
    required this.deviceId,
    required this.channelId,
    required this.functionsRegion,
    required this.projectId,
    required this.appId,
    required this.apiKey,
    required this.messagingSenderId,
    required this.storageBucket,
    required this.authDomain,
    required this.firestoreEmulatorHost,
    required this.firestoreEmulatorPort,
    required this.functionsEmulatorHost,
    required this.functionsEmulatorPort,
    required this.error,
  });

  factory BackendConfig.fromEnvironment() =>
      BackendConfig.parse(<String, String>{
        'BACKEND_MODE': const String.fromEnvironment(
          'BACKEND_MODE',
          defaultValue: 'offline',
        ),
        'TV_PARTY_ID': const String.fromEnvironment('TV_PARTY_ID'),
        'TV_DEVICE_ID': const String.fromEnvironment('TV_DEVICE_ID'),
        'TV_CHANNEL_ID': const String.fromEnvironment('TV_CHANNEL_ID'),
        'FUNCTIONS_REGION': const String.fromEnvironment(
          'FUNCTIONS_REGION',
          defaultValue: 'us-central1',
        ),
        'FIREBASE_PROJECT_ID': const String.fromEnvironment(
          'FIREBASE_PROJECT_ID',
        ),
        'FIREBASE_APP_ID': const String.fromEnvironment('FIREBASE_APP_ID'),
        'FIREBASE_API_KEY': const String.fromEnvironment('FIREBASE_API_KEY'),
        'FIREBASE_MESSAGING_SENDER_ID': const String.fromEnvironment(
          'FIREBASE_MESSAGING_SENDER_ID',
        ),
        'FIREBASE_STORAGE_BUCKET': const String.fromEnvironment(
          'FIREBASE_STORAGE_BUCKET',
        ),
        'FIREBASE_AUTH_DOMAIN': const String.fromEnvironment(
          'FIREBASE_AUTH_DOMAIN',
        ),
        'FIRESTORE_EMULATOR_HOST': const String.fromEnvironment(
          'FIRESTORE_EMULATOR_HOST',
        ),
        'FIRESTORE_EMULATOR_PORT': const String.fromEnvironment(
          'FIRESTORE_EMULATOR_PORT',
        ),
        'FUNCTIONS_EMULATOR_HOST': const String.fromEnvironment(
          'FUNCTIONS_EMULATOR_HOST',
        ),
        'FUNCTIONS_EMULATOR_PORT': const String.fromEnvironment(
          'FUNCTIONS_EMULATOR_PORT',
        ),
      });

  factory BackendConfig.parse(Map<String, String> values) {
    final String modeText = (values['BACKEND_MODE'] ?? 'offline')
        .trim()
        .toLowerCase();
    final BackendMode mode = switch (modeText) {
      'firebase' => BackendMode.firebase,
      'emulator' => BackendMode.emulator,
      _ => BackendMode.offline,
    };
    String value(String key) => (values[key] ?? '').trim();
    final String region = value('FUNCTIONS_REGION').isEmpty
        ? 'us-central1'
        : value('FUNCTIONS_REGION');
    final int? firestorePort = int.tryParse(value('FIRESTORE_EMULATOR_PORT'));
    final int? functionsPort = int.tryParse(value('FUNCTIONS_EMULATOR_PORT'));
    String? error;
    final String rawChannel = value('TV_CHANNEL_ID');
    // Offline/emulator builds keep the bundled CCTV fixture behavior
    // byte-for-byte: an unset TV_CHANNEL_ID falls back to the
    // haunted-surveillance channel. Firebase (live) requires a provisioned
    // registered id, validated exactly like TV_PARTY_ID/TV_DEVICE_ID.
    final String channelId = rawChannel.isEmpty
        ? hauntedSurveillanceChannelId
        : rawChannel;
    if (!<String>{'offline', 'firebase', 'emulator'}.contains(modeText)) {
      error = 'unknown BACKEND_MODE';
    } else if (mode != BackendMode.offline) {
      final List<String> missing = <String>[
        if (value('TV_PARTY_ID').isEmpty) 'TV_PARTY_ID',
        if (value('TV_DEVICE_ID').isEmpty) 'TV_DEVICE_ID',
        if (mode == BackendMode.firebase && rawChannel.isEmpty)
          'TV_CHANNEL_ID',
        if (value('FIREBASE_PROJECT_ID').isEmpty) 'FIREBASE_PROJECT_ID',
        if (value('FIREBASE_APP_ID').isEmpty) 'FIREBASE_APP_ID',
        if (value('FIREBASE_API_KEY').isEmpty) 'FIREBASE_API_KEY',
        if (value('FIREBASE_MESSAGING_SENDER_ID').isEmpty)
          'FIREBASE_MESSAGING_SENDER_ID',
      ];
      if (missing.isNotEmpty) {
        error = 'live configuration is incomplete: ${missing.join(', ')}';
      } else if (!_registeredId.hasMatch(value('TV_PARTY_ID')) ||
          !_registeredId.hasMatch(value('TV_DEVICE_ID')) ||
          (mode == BackendMode.firebase &&
              !_registeredId.hasMatch(rawChannel))) {
        error =
            'TV_PARTY_ID, TV_DEVICE_ID and TV_CHANNEL_ID must be provisioned identifier values';
      } else if (mode == BackendMode.emulator &&
          (value('FIRESTORE_EMULATOR_HOST').isEmpty ||
              firestorePort == null ||
              firestorePort < 1 ||
              firestorePort > 65535 ||
              value('FUNCTIONS_EMULATOR_HOST').isEmpty ||
              functionsPort == null ||
              functionsPort < 1 ||
              functionsPort > 65535)) {
        error =
            'emulator mode requires valid Firestore and Functions addresses';
      } else if (region.isEmpty || region.contains('/')) {
        error = 'FUNCTIONS_REGION must be a region name';
      }
    }
    return BackendConfig._(
      mode: mode,
      partyId: value('TV_PARTY_ID'),
      deviceId: value('TV_DEVICE_ID'),
      channelId: channelId,
      functionsRegion: region,
      projectId: value('FIREBASE_PROJECT_ID'),
      appId: value('FIREBASE_APP_ID'),
      apiKey: value('FIREBASE_API_KEY'),
      messagingSenderId: value('FIREBASE_MESSAGING_SENDER_ID'),
      storageBucket: value('FIREBASE_STORAGE_BUCKET'),
      authDomain: value('FIREBASE_AUTH_DOMAIN'),
      firestoreEmulatorHost: value('FIRESTORE_EMULATOR_HOST'),
      firestoreEmulatorPort: firestorePort,
      functionsEmulatorHost: value('FUNCTIONS_EMULATOR_HOST'),
      functionsEmulatorPort: functionsPort,
      error: error,
    );
  }

  final BackendMode mode;
  final String partyId;
  final String deviceId;
  final String channelId;
  final String functionsRegion;
  final String projectId;
  final String appId;
  final String apiKey;
  final String messagingSenderId;
  final String storageBucket;
  final String authDomain;
  final String firestoreEmulatorHost;
  final int? firestoreEmulatorPort;
  final String functionsEmulatorHost;
  final int? functionsEmulatorPort;
  final String? error;

  bool get isLiveRequested => mode != BackendMode.offline;
  bool get isLiveConfigured => isLiveRequested && error == null;
  bool get useEmulator => mode == BackendMode.emulator && isLiveConfigured;
  String get partyIdOrOffline => partyId.isEmpty ? 'local-party' : partyId;

  static final RegExp _registeredId = RegExp(
    r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$',
  );

  FirebaseOptions? get firebaseOptions => isLiveConfigured
      ? FirebaseOptions(
          apiKey: apiKey,
          appId: appId,
          messagingSenderId: messagingSenderId,
          projectId: projectId,
          storageBucket: storageBucket.isEmpty ? null : storageBucket,
          authDomain: authDomain.isEmpty ? null : authDomain,
        )
      : null;
}
