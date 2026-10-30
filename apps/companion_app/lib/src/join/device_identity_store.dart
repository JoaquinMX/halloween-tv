import 'dart:math';
import 'package:shared_preferences/shared_preferences.dart';

/// Installation identity persisted app-wide. Persistence is required before an id is returned.
final class DeviceIdentityStore {
  DeviceIdentityStore({Future<SharedPreferences> Function()? preferences, Random? random}) : _preferences = preferences ?? SharedPreferences.getInstance, _random = random ?? Random.secure();
  static const String storageKey = 'companion.phone_device_id.v1';
  final Future<SharedPreferences> Function() _preferences;
  final Random _random;
  Future<String>? _pending;

  Future<String> getDeviceId() => _pending ??= _loadOrCreate().then((id) { return id; }).catchError((Object error) { _pending = null; throw error; });

  Future<String> _loadOrCreate() async {
    final prefs = await _preferences();
    final stored = prefs.getString(storageKey);
    if (stored != null && RegExp(r'^p-[0-9a-f]{32}$').hasMatch(stored)) return stored;
    final bytes = List<int>.generate(16, (_) => _random.nextInt(256));
    final id = 'p-${bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
    if (!await prefs.setString(storageKey, id)) throw StateError('Unable to persist phone identity');
    return id;
  }
}
