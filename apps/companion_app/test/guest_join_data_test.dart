import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:flutter_test/flutter_test.dart';
const id = 'p-0123456789abcdef0123456789abcdef';
void main() {
  test('manual values bind local identity and retain leading zero PIN', () {
    final result = parseGuestJoinFields(partyId: 'party-a', localDeviceId: id, channelId: 'cctv', joinPin: '004201');
    expect(result, isA<Ok<GuestJoinData>>());
    final value = (result as Ok<GuestJoinData>).value;
    expect(value.deviceId.value, id); expect(value.joinPin, '004201');
  });
  test('blank PIN is absent and malformed PIN or injected identity is rejected', () {
    expect((parseGuestJoinFields(partyId: 'p', localDeviceId: id, channelId: 'c', joinPin: ' ') as Ok<GuestJoinData>).value.joinPin, isNull);
    expect(parseGuestJoinFields(partyId: 'p', localDeviceId: id, channelId: 'c', joinPin: '12345'), isA<Err<GuestJoinData>>());
    expect(parseGuestJoinFields(partyId: 'p', localDeviceId: 'attacker-id', channelId: 'c'), isA<Err<GuestJoinData>>());
  });
  test('pasted JSON ignores supplied device ids and extra keys', () {
    final result = parseGuestJoinPayload('{"partyId":"p","channelId":"c","deviceId":"attacker","device_id":"attacker2","joinPin":"000007","extra":true}', localDeviceId: id);
    final value = (result as Ok<GuestJoinData>).value;
    expect(value.deviceId.value, id); expect(value.joinPin, '000007');
  });
  test('rejects URLs, malformed, nonobjects, and invalid identifier shapes', () {
    for (final input in ['https://example.org', '{bad', '[]', '42']) { expect(parseGuestJoinPayload(input, localDeviceId: id), isA<Err<GuestJoinData>>()); }
    expect(parseGuestJoinPayload('{"partyId":"p","channelId":"c","joinPin":"12x456"}', localDeviceId: id), isA<Err<GuestJoinData>>());
  });
}
