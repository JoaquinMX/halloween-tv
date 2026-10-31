import 'dart:math';
import 'package:shared_preferences/shared_preferences.dart';

/// Installation identities persisted app-wide, one per role.
///
/// The guest phone identity ([storageKey]) authorizes `joinParty`; the host
/// phone identity ([hostStorageKey]) redeems `joinHost`. The keys are
/// separate so switching roles can never overwrite or promote an existing
/// guest registration: joining as host leaves the guest device doc (and its
/// receipts) untouched, and vice versa. Persistence is required before an
/// id is returned.
final class DeviceIdentityStore {
  DeviceIdentityStore({
    Future<SharedPreferences> Function()? preferences,
    Random? random,
  }) : _preferences = preferences ?? SharedPreferences.getInstance,
       _random = random ?? Random.secure();
  static const String storageKey = 'companion.phone_device_id.v1';

  /// Separate host phone identity for `joinHost` redemption.
  ///
  /// A guest-PIN registration (role guest) can never be upgraded by
  /// re-presenting a host invite for the same device id — the backend
  /// rejects guest docs at redemption — so the host flow mints and persists
  /// its own installation id under this key.
  static const String hostStorageKey = 'companion.host_phone_device_id.v1';

  final Future<SharedPreferences> Function() _preferences;
  final Random _random;
  final Map<String, Future<String>> _pending = <String, Future<String>>{};

  Future<String> getDeviceId() => _pending.putIfAbsent(
    storageKey,
    () => _loadOrCreate(storageKey).then((id) => id).catchError((Object error) {
      _pending.remove(storageKey);
      throw error;
    }),
  );

  Future<String> getHostDeviceId() => _pending.putIfAbsent(
    hostStorageKey,
    () => _loadOrCreate(hostStorageKey).then((id) => id).catchError((
      Object error,
    ) {
      _pending.remove(hostStorageKey);
      throw error;
    }),
  );

  Future<String> _loadOrCreate(String key) async {
    final prefs = await _preferences();
    final stored = prefs.getString(key);
    if (stored != null && RegExp(r'^p-[0-9a-f]{32}$').hasMatch(stored)) {
      return stored;
    }
    final bytes = List<int>.generate(16, (_) => _random.nextInt(256));
    final id =
        'p-${bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
    if (!await prefs.setString(key, id)) {
      throw StateError('Unable to persist phone identity');
    }
    return id;
  }
}
