/// Settings port adapters (party-scoped key/value storage).
///
/// Design authority: Technical Design v1.0 §8.2 (ports).
///
/// Port direction (finding D-08 — recorded here): the `SettingsPort`
/// interface is owned by the contracts layer and lives in
/// `package:channel_api/channel_api.dart`. This library ships the adapters
/// ([InMemorySettings]; later SharedPreferences-/Firestore-backed ones) and
/// nothing else — there is no infra-local port declaration, so channels
/// consume settings without ever importing `infra_*`.
///
/// Backwards compatibility: the barrel
/// (`package:infra_settings/infra_settings.dart`) still re-exports
/// [SettingsPort] through this library so existing importers keep
/// compiling; the re-export carries an `@Deprecated` annotation recording
/// the move (Dart raises no deprecation diagnostic for export directives,
/// so the deprecation here is documentation-level — new code must import
/// the port from `channel_api`).
///
/// Party scoping uses the canonical `core_foundation` [PartyId] value type
/// (it is the same identity carried by `PlaybackManifest.partyId`; pass
/// `PlaybackManifest.partyId` through `PartyId(...)` at the edge).
/// No `dart:io` in port signatures.
library;

import 'package:channel_api/channel_api.dart' show SettingsPort;
import 'package:core_foundation/core_foundation.dart';

@Deprecated(
  'SettingsPort moved to the contracts layer (finding D-08): import it from '
  'package:channel_api/channel_api.dart. This infra re-export is kept only '
  'so existing importers compile.',
)
export 'package:channel_api/channel_api.dart' show SettingsPort;

/// In-memory [SettingsPort] for tests, previews, and local playback.
///
/// Storage is a per-party, per-type map: string and bool values with the
/// same key are independent and never overwrite each other. Not persisted
/// — state dies with the instance.
///
/// PRODUCTION REPLACEMENT: a SharedPreferences adapter keyed by
/// `$partyId/$key`, or Firestore `parties/{partyId}/settings/{key}`. The
/// contracts-layer port signature stays unchanged; only the constructor at
/// the composition root swaps.
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
