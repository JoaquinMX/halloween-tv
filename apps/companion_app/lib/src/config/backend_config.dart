/// External, non-secret build configuration for the companion backend.
///
/// Values are supplied from an externally provided Firebase options file
/// (`config/firebase.json`, shaped like `config/firebase.example.json`,
/// which holds PLACEHOLDERS only). Missing files, missing fields, or
/// invalid values resolve to [CompanionBackendMode.unconfigured]: the app
/// boots offline without touching Firebase. A partially filled file never
/// silently selects a cloud target — [error] records the recoverable
/// configuration state instead.
library;

import 'dart:convert';

import 'package:firebase_core/firebase_core.dart';

/// Companion backend selection. There is no TV-style `offline` define here:
/// the default (no options file) is [unconfigured].
enum CompanionBackendMode { unconfigured, firebase, emulator }

/// Parsed Firebase options for the companion app.
///
/// Only public client options are held here ([apiKey], [appId],
/// [projectId]); there are no secrets, identities, or credentials.
final class BackendConfig {
  const BackendConfig._({
    required this.mode,
    required this.apiKey,
    required this.appId,
    required this.projectId,
    required this.messagingSenderId,
    required this.functionsRegion,
    required this.functionsEmulatorHost,
    required this.functionsEmulatorPort,
    required this.error,
  });

  /// Default boot state: no Firebase, no error.
  factory BackendConfig.unconfigured([String? reason]) => BackendConfig._(
    mode: CompanionBackendMode.unconfigured,
    apiKey: '',
    appId: '',
    projectId: '',
    messagingSenderId: '',
    functionsRegion: defaultFunctionsRegion,
    functionsEmulatorHost: '',
    functionsEmulatorPort: null,
    error: reason,
  );

  /// Parses decoded JSON shaped like `config/firebase.example.json`.
  ///
  /// Never throws on invalid input: failures resolve to
  /// [CompanionBackendMode.unconfigured] with [error] set.
  factory BackendConfig.parse(Map<String, Object?> json) {
    String text(Object? value) => (value is String ? value : '').trim();
    final String apiKey = text(json['apiKey']);
    final String appId = text(json['appId']);
    final String projectId = text(json['projectId']);
    final String messagingSenderId = text(json['messagingSenderId']);
    final String region = text(json['functionsRegion']).isEmpty
        ? defaultFunctionsRegion
        : text(json['functionsRegion']);
    final String emulatorHost = text(json['functionsEmulatorHost']);
    final Object? rawPort = json['functionsEmulatorPort'];
    final int? emulatorPort = switch (rawPort) {
      null => null,
      final int v => v,
      final num v when v == v.truncateToDouble() => v.toInt(),
      final String v => int.tryParse(v.trim()),
      _ => null,
    };

    String? error;
    CompanionBackendMode mode = CompanionBackendMode.unconfigured;
    final bool liveRequested =
        apiKey.isNotEmpty || appId.isNotEmpty || projectId.isNotEmpty;
    final bool emulatorRequested = emulatorHost.isNotEmpty || rawPort != null;
    if (!liveRequested && !emulatorRequested) {
      // Default: unconfigured/offline boot, no error.
    } else if (apiKey.isEmpty || appId.isEmpty || projectId.isEmpty) {
      error =
          'firebase options are incomplete: apiKey, appId, and projectId '
          'are all required';
    } else if (region.isEmpty || region.contains('/')) {
      error = 'functionsRegion must be a region name';
    } else if (emulatorRequested) {
      if (emulatorHost.isEmpty ||
          emulatorPort == null ||
          emulatorPort < 1 ||
          emulatorPort > 65535) {
        error =
            'emulator mode requires a valid functionsEmulatorHost and '
            'functionsEmulatorPort (1-65535)';
      } else {
        mode = CompanionBackendMode.emulator;
      }
    } else {
      mode = CompanionBackendMode.firebase;
    }
    if (error != null) {
      mode = CompanionBackendMode.unconfigured;
    }
    return BackendConfig._(
      mode: mode,
      apiKey: apiKey,
      appId: appId,
      projectId: projectId,
      messagingSenderId: messagingSenderId,
      functionsRegion: region,
      functionsEmulatorHost: emulatorHost,
      functionsEmulatorPort: emulatorPort,
      error: error,
    );
  }

  /// Parses raw JSON text; malformed JSON resolves to unconfigured + error.
  static BackendConfig parseJson(String source) {
    try {
      final Object? decoded = jsonDecode(source);
      if (decoded is! Map) {
        return BackendConfig.unconfigured(
          'firebase options must be a JSON object',
        );
      }
      return BackendConfig.parse(
        Map<String, Object?>.from(decoded as Map<Object?, Object?>),
      );
    } on FormatException catch (error) {
      return BackendConfig.unconfigured(
        'firebase options are not valid JSON'
        '${error.message.isEmpty ? '' : ': ${error.message}'}',
      );
    }
  }

  static const String defaultFunctionsRegion = 'us-central1';

  final CompanionBackendMode mode;
  final String apiKey;
  final String appId;
  final String projectId;
  final String messagingSenderId;
  final String functionsRegion;
  final String functionsEmulatorHost;
  final int? functionsEmulatorPort;

  /// Recoverable configuration problem, or `null` when valid.
  final String? error;

  /// True when a cloud target was explicitly selected and validated.
  bool get isLiveConfigured =>
      error == null && mode != CompanionBackendMode.unconfigured;

  /// True when the Functions emulator is the selected target.
  bool get useEmulator =>
      isLiveConfigured && mode == CompanionBackendMode.emulator;

  /// Public client options, or `null` when unconfigured.
  ///
  /// The companion uses no messaging: [FirebaseOptions.messagingSenderId]
  /// is defaulted to empty and only Functions/Firestore are touched. A
  /// platform that rejects that surfaces through the composition root as a
  /// recoverable configuration state, never a silent cloud target.
  FirebaseOptions? get firebaseOptions => isLiveConfigured
      ? FirebaseOptions(
          apiKey: apiKey,
          appId: appId,
          messagingSenderId: messagingSenderId,
          projectId: projectId,
        )
      : null;
}
