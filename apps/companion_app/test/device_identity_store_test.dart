import 'dart:math';
import 'package:companion_app/src/join/device_identity_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('persists and reuses installation identity across store instances', () async {
    SharedPreferences.setMockInitialValues({});
    final one = await DeviceIdentityStore().getDeviceId();
    final two = await DeviceIdentityStore().getDeviceId();
    expect(one, matches(RegExp(r'^p-[0-9a-f]{32}$'))); expect(two, one);
  });
  test('concurrent initialization is single flight', () async {
    SharedPreferences.setMockInitialValues({}); var calls = 0;
    final store = DeviceIdentityStore(preferences: () async { calls++; await Future<void>.delayed(Duration.zero); return SharedPreferences.getInstance(); }, random: Random(3));
    final ids = await Future.wait([store.getDeviceId(), store.getDeviceId(), store.getDeviceId()]);
    expect(ids.toSet(), hasLength(1)); expect(calls, 1);
  });
  test('corrupt storage is replaced and persisted', () async {
    SharedPreferences.setMockInitialValues({DeviceIdentityStore.storageKey: 'bad'});
    final id = await DeviceIdentityStore(random: Random(5)).getDeviceId();
    expect(id, matches(RegExp(r'^p-[0-9a-f]{32}$'))); expect((await SharedPreferences.getInstance()).getString(DeviceIdentityStore.storageKey), id);
  });
  test('host identity is separate and never overwrites the guest identity', () async {
    SharedPreferences.setMockInitialValues({});
    final store = DeviceIdentityStore(random: Random(7));
    final guest = await store.getDeviceId();
    final host = await store.getHostDeviceId();
    expect(host, matches(RegExp(r'^p-[0-9a-f]{32}$')));
    expect(host, isNot(guest));
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(DeviceIdentityStore.storageKey), guest);
    expect(prefs.getString(DeviceIdentityStore.hostStorageKey), host);
    // Repeat reads reuse both identities; switching roles keeps each key.
    expect(await DeviceIdentityStore().getDeviceId(), guest);
    expect(await DeviceIdentityStore().getHostDeviceId(), host);
  });
  test('corrupt host storage is replaced without touching the guest key', () async {
    SharedPreferences.setMockInitialValues({DeviceIdentityStore.storageKey: 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', DeviceIdentityStore.hostStorageKey: 'bad'});
    final host = await DeviceIdentityStore(random: Random(9)).getHostDeviceId();
    expect(host, matches(RegExp(r'^p-[0-9a-f]{32}$')));
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(DeviceIdentityStore.storageKey), 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(prefs.getString(DeviceIdentityStore.hostStorageKey), host);
  });
}
