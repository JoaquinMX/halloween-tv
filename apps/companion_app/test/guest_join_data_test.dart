import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:flutter_test/flutter_test.dart';
const id = 'p-0123456789abcdef0123456789abcdef';
const hostId = 'p-ffffffffffffffffffffffffffffffff';
const hostToken = 'hi-0123456789abcdef0123456789abcdef0123456789abcdef';
String longId(int length) => List.filled(length, 'a').join();
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
  test('trims identifiers and accepts snake_case keys', () {
    final fields = parseGuestJoinFields(partyId: '  party-a  ', localDeviceId: id, channelId: '  cctv ', joinPin: ' 004201 ');
    expect(fields, isA<Ok<GuestJoinData>>());
    final bound = (fields as Ok<GuestJoinData>).value;
    expect(bound.partyId.value, 'party-a');
    expect(bound.channelId, 'cctv');
    expect(bound.joinPin, '004201');
    final payload = parseGuestJoinPayload('{"party_id":"p","channel_id":"c","join_pin":"000007"}', localDeviceId: id);
    expect(payload, isA<Ok<GuestJoinData>>());
    final pasted = (payload as Ok<GuestJoinData>).value;
    expect(pasted.partyId.value, 'p');
    expect(pasted.channelId, 'c');
    expect(pasted.joinPin, '000007');
  });
  test('rejects empty, overlong, and missing identifiers', () {
    expect(parseGuestJoinFields(partyId: '', localDeviceId: id, channelId: 'c'), isA<Err<GuestJoinData>>());
    expect(parseGuestJoinFields(partyId: '   ', localDeviceId: id, channelId: 'c'), isA<Err<GuestJoinData>>());
    expect(parseGuestJoinFields(partyId: 'p', localDeviceId: id, channelId: ''), isA<Err<GuestJoinData>>());
    expect(parseGuestJoinFields(partyId: longId(129), localDeviceId: id, channelId: 'c'), isA<Err<GuestJoinData>>());
    expect(parseGuestJoinFields(partyId: 'p', localDeviceId: id, channelId: longId(129)), isA<Err<GuestJoinData>>());
    expect(parseGuestJoinFields(partyId: longId(128), localDeviceId: id, channelId: 'c'), isA<Ok<GuestJoinData>>());
    expect(parseGuestJoinPayload('{"channelId":"c"}', localDeviceId: id), isA<Err<GuestJoinData>>());
    expect(parseGuestJoinPayload('{"partyId":"p"}', localDeviceId: id), isA<Err<GuestJoinData>>());
    expect(parseGuestJoinPayload('{}', localDeviceId: id), isA<Err<GuestJoinData>>());
  });
  test('a pasted non-string PIN is a PIN error, not an identifier error', () {
    final result = parseGuestJoinPayload('{"partyId":"p","channelId":"c","joinPin":4201}', localDeviceId: id);
    expect(result, isA<Err<GuestJoinData>>());
    expect((result as Err<GuestJoinData>).message, contains('joinPin'));
    expect(result.message, isNot(contains('partyId and channelId')));
  });
  test('absent role means guest for legacy payloads', () {
    final fields = parseGuestJoinFields(partyId: 'p', localDeviceId: id, channelId: 'c');
    expect((fields as Ok<GuestJoinData>).value.role, JoinRole.guest);
    final payload = parseGuestJoinPayload('{"partyId":"p","channelId":"c"}', localDeviceId: id);
    final value = (payload as Ok<GuestJoinData>).value;
    expect(value.role, JoinRole.guest);
    expect(value.inviteToken, isNull);
    final explicit = parseGuestJoinPayload('{"partyId":"p","channelId":"c","role":"guest"}', localDeviceId: id);
    expect((explicit as Ok<GuestJoinData>).value.role, JoinRole.guest);
  });
  test('host payloads carry the invite capability, never a PIN', () {
    final fields = parseHostJoinFields(partyId: 'p', localDeviceId: hostId, channelId: 'c', inviteToken: hostToken);
    final value = (fields as Ok<GuestJoinData>).value;
    expect(value.role, JoinRole.host);
    expect(value.inviteToken, hostToken);
    expect(value.joinPin, isNull);
    expect(value.deviceId.value, hostId);
    final payload = parseGuestJoinPayload('{"partyId":"p","channelId":"c","role":"host","inviteToken":"$hostToken"}', localDeviceId: hostId);
    final pasted = (payload as Ok<GuestJoinData>).value;
    expect(pasted.role, JoinRole.host);
    expect(pasted.inviteToken, hostToken);
    final snake = parseGuestJoinPayload('{"party_id":"p","channel_id":"c","role":"host","invite_token":"$hostToken"}', localDeviceId: hostId);
    expect((snake as Ok<GuestJoinData>).value.role, JoinRole.host);
  });
  test('unknown roles and malformed host capabilities fail visibly', () {
    for (final raw in ['{"partyId":"p","channelId":"c","role":"admin"}', '{"partyId":"p","channelId":"c","role":"tv"}', '{"partyId":"p","channelId":"c","role":""}', '{"partyId":"p","channelId":"c","role":7}']) {
      final result = parseGuestJoinPayload(raw, localDeviceId: id);
      expect(result, isA<Err<GuestJoinData>>(), reason: raw);
      expect((result as Err<GuestJoinData>).message, contains('role'));
    }
    // Host without a token, with a PIN-shaped token, or with a joinPin.
    for (final raw in ['{"partyId":"p","channelId":"c","role":"host"}', '{"partyId":"p","channelId":"c","role":"host","inviteToken":"004201"}', '{"partyId":"p","channelId":"c","role":"host","inviteToken":""}', '{"partyId":"p","channelId":"c","role":"host","inviteToken":"$hostToken","joinPin":"004201"}']) {
      final result = parseGuestJoinPayload(raw, localDeviceId: hostId);
      expect(result, isA<Err<GuestJoinData>>(), reason: raw);
    }
    // PIN-shaped tokens are named as token errors, not identifier errors.
    final pinToken = parseGuestJoinPayload('{"partyId":"p","channelId":"c","role":"host","inviteToken":"004201"}', localDeviceId: hostId);
    expect((pinToken as Err<GuestJoinData>).message, contains('inviteToken'));
    // Guest payloads must not carry a host capability.
    final guestWithToken = parseGuestJoinPayload('{"partyId":"p","channelId":"c","inviteToken":"$hostToken"}', localDeviceId: id);
    expect(guestWithToken, isA<Err<GuestJoinData>>());
    expect((guestWithToken as Err<GuestJoinData>).message, contains('inviteToken'));
  });
}
