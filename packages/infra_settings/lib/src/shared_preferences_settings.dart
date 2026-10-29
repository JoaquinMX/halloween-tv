/// Persistent SharedPreferences settings adapter (party-scoped key/value).
///
/// Design authority: Technical Design v1.0 §8.2 (ports).
library;

import 'dart:convert';

import 'package:channel_api/channel_api.dart' show SettingsPort;
import 'package:core_foundation/core_foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:infra_settings/src/settings_port.dart' show InMemorySettings;

/// Persistent SharedPreferences adapter with an in-memory fallback.
///
/// If the platform preferences plugin is not ready or fails, reads and writes
/// continue against [fallback]. Values already present in [fallback] are
/// copied into persistent storage on their first read, which supports a safe
/// migration from a bundled boot session without changing the SettingsPort.
final class SharedPreferencesSettings implements SettingsPort {
  SharedPreferencesSettings({
    SharedPreferences? preferences,
    InMemorySettings? fallback,
  }) : _preferences = preferences,
       fallback = fallback ?? InMemorySettings();

  SharedPreferences? _preferences;
  final InMemorySettings fallback;

  Future<SharedPreferences?> _loadPreferences() async {
    if (_preferences != null) return _preferences;
    try {
      _preferences = await SharedPreferences.getInstance();
      return _preferences;
    } on Object {
      // Some test/boot paths run before a platform channel is available.
      return null;
    }
  }

  @override
  Future<String?> getString({
    required PartyId partyId,
    required String key,
  }) async {
    _requireKey(key);
    final SharedPreferences? preferences = await _loadPreferences();
    if (preferences != null) {
      final String storageKey = _storageKey(partyId, key, 'string');
      try {
        final String? value = preferences.getString(storageKey);
        if (value != null) {
          await fallback.setString(partyId: partyId, key: key, value: value);
          return value;
        }
      } on Object {
        // Recover through the in-memory state if a persisted value is corrupt.
      }
      final String? legacy = await fallback.getString(
        partyId: partyId,
        key: key,
      );
      if (legacy != null) {
        try {
          await preferences.setString(storageKey, legacy);
        } on Object {
          // Keep serving the migrated value in memory if persistence fails.
        }
      }
      return legacy;
    }
    return fallback.getString(partyId: partyId, key: key);
  }

  @override
  Future<void> setString({
    required PartyId partyId,
    required String key,
    required String value,
  }) async {
    _requireKey(key);
    await fallback.setString(partyId: partyId, key: key, value: value);
    final SharedPreferences? preferences = await _loadPreferences();
    if (preferences == null) return;
    try {
      await preferences.setString(_storageKey(partyId, key, 'string'), value);
    } on Object {
      // The in-memory copy remains available for this process.
    }
  }

  @override
  Future<bool?> getBool({required PartyId partyId, required String key}) async {
    _requireKey(key);
    final SharedPreferences? preferences = await _loadPreferences();
    if (preferences != null) {
      final String storageKey = _storageKey(partyId, key, 'bool');
      try {
        final bool? value = preferences.getBool(storageKey);
        if (value != null) {
          await fallback.setBool(partyId: partyId, key: key, value: value);
          return value;
        }
      } on Object {
        // Recover through the in-memory state if a persisted value is corrupt.
      }
      final bool? legacy = await fallback.getBool(partyId: partyId, key: key);
      if (legacy != null) {
        try {
          await preferences.setBool(storageKey, legacy);
        } on Object {
          // Keep serving the migrated value in memory if persistence fails.
        }
      }
      return legacy;
    }
    return fallback.getBool(partyId: partyId, key: key);
  }

  @override
  Future<void> setBool({
    required PartyId partyId,
    required String key,
    required bool value,
  }) async {
    _requireKey(key);
    await fallback.setBool(partyId: partyId, key: key, value: value);
    final SharedPreferences? preferences = await _loadPreferences();
    if (preferences == null) return;
    try {
      await preferences.setBool(_storageKey(partyId, key, 'bool'), value);
    } on Object {
      // The in-memory copy remains available for this process.
    }
  }

  static String _storageKey(PartyId partyId, String key, String type) {
    final String scope = base64Url.encode(
      utf8.encode(jsonEncode(<String>[partyId.value, key])),
    );
    return 'halloween_tv.settings.v1.$type.$scope';
  }

  static void _requireKey(String key) {
    if (key.trim().isEmpty) {
      throw ArgumentError.value(key, 'key', 'settings key must be non-empty');
    }
  }
}
