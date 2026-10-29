/// Settings port: key/value storage scoped by party.
///
/// Design authority: Technical Design v1.0 §8.2 (ports).
/// Interface only — zero network calls, zero firebase SDK imports.
///
/// Party scoping uses the canonical `core_foundation` [PartyId] value type
/// (it is the same identity carried by `PlaybackManifest.partyId`; pass
/// `PlaybackManifest.partyId` through `PartyId(...)` at the edge).
/// No `dart:io` in port signatures.
library;

import 'package:core_foundation/core_foundation.dart';

/// Abstract settings store. Every key is scoped by [partyId] so concurrent
/// parties (watch-party sessions) never share state.
///
/// Implementations: [InMemorySettings] (tests/previews), and later a
/// SharedPreferences- or Firestore-backed adapter behind the same port.
abstract interface class SettingsPort {
  /// Reads a string setting, or `null` when unset (or stored as another
  /// type).
  Future<String?> getString({required PartyId partyId, required String key});

  /// Writes a string setting for [partyId].
  Future<void> setString({
    required PartyId partyId,
    required String key,
    required String value,
  });

  /// Reads a bool setting, or `null` when unset (or stored as another type).
  Future<bool?> getBool({required PartyId partyId, required String key});

  /// Writes a bool setting for [partyId].
  Future<void> setBool({
    required PartyId partyId,
    required String key,
    required bool value,
  });
}

/// In-memory [SettingsPort] for tests, previews, and local playback.
///
/// Storage is a per-party, per-type map: string and bool values with the
/// same key are independent and never overwrite each other. Not persisted
/// — state dies with the instance.
///
/// PRODUCTION REPLACEMENT: a SharedPreferences adapter keyed by
/// `$partyId/$key`, or Firestore `parties/{partyId}/settings/{key}`. The
/// port signature stays unchanged; only the constructor at the composition
/// root swaps.
class InMemorySettings implements SettingsPort {
  final Map<String, Map<String, String>> _strings = {};
  final Map<String, Map<String, bool>> _bools = {};

  static String _requireKey(String key) {
    if (key.trim().isEmpty) {
      throw ArgumentError.value(key, 'key', 'settings key must be non-empty');
    }
    return key;
  }

  @override
  Future<String?> getString({
    required PartyId partyId,
    required String key,
  }) async {
    _requireKey(key);
    return _strings[partyId.value]?[key];
  }

  @override
  Future<void> setString({
    required PartyId partyId,
    required String key,
    required String value,
  }) async {
    _requireKey(key);
    (_strings[partyId.value] ??= {})[key] = value;
  }

  @override
  Future<bool?> getBool({required PartyId partyId, required String key}) async {
    _requireKey(key);
    return _bools[partyId.value]?[key];
  }

  @override
  Future<void> setBool({
    required PartyId partyId,
    required String key,
    required bool value,
  }) async {
    _requireKey(key);
    (_bools[partyId.value] ??= {})[key] = value;
  }
}
