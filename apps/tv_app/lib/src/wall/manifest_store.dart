/// Persistence for the last good wall manifest (offline restore).
library;

import 'dart:convert';

import 'package:core_playlist/core_playlist.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Storage port for the last applied `PlaybackManifest`.
///
/// Kept as an interface so tests and later phases (Firestore/settings based
/// storage) can swap the implementation without touching boot logic.
abstract interface class WallManifestStore {
  /// Returns the last stored manifest, or null when absent/unreadable.
  Future<PlaybackManifest?> read();

  /// Persists [manifest] as the last known good wall.
  Future<void> write(PlaybackManifest manifest);
}

/// SharedPreferences-backed manifest store (survives app restarts on TV).
final class PrefsManifestStore implements WallManifestStore {
  /// Creates the store, optionally overriding the preferences key.
  const PrefsManifestStore({this.key = 'halloween_tv.wall_manifest.v1'});

  /// Preferences key holding the serialized manifest JSON.
  final String key;

  @override
  Future<PlaybackManifest?> read() async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    final String? raw = prefs.getString(key);
    if (raw == null || raw.isEmpty) {
      return null;
    }
    try {
      final Object? decoded = jsonDecode(raw);
      if (decoded is! Map<Object?, Object?>) {
        return null;
      }
      return parseManifest(Map<String, Object?>.from(decoded));
    } on FormatException {
      // Corrupt/older payload: treat as "no cached wall" and fall back to
      // the bundled fixture instead of crashing the boot.
      return null;
    }
  }

  @override
  Future<void> write(PlaybackManifest manifest) async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    await prefs.setString(key, jsonEncode(manifest.toJson()));
  }
}
