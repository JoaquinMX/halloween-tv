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
}
