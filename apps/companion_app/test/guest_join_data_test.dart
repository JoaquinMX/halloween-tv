// Guest join payload tests: valid/invalid inputs, data-only posture, and
// refusal to synthesize identifiers. Exercises the real prod parsers.

import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('parseGuestJoinFields', () {
    test('accepts valid manual fields', () {
      final Result<GuestJoinData> result = parseGuestJoinFields(
        partyId: 'party-1',
        deviceId: 'device-9',
        channelId: 'cctv',
      );
      expect(result, isA<Ok<GuestJoinData>>());
      final GuestJoinData data = (result as Ok<GuestJoinData>).value;
      expect(data.partyId, PartyId('party-1'));
      expect(data.deviceId, DeviceId('device-9'));
      expect(data.channelId, 'cctv');
    });

    test('trims surrounding whitespace', () {
      final Result<GuestJoinData> result = parseGuestJoinFields(
        partyId: '  party-1  ',
        deviceId: '\tdevice-9\n',
        channelId: ' cctv ',
      );
      expect(result, isA<Ok<GuestJoinData>>());
      final GuestJoinData data = (result as Ok<GuestJoinData>).value;
      expect(data.partyId.value, 'party-1');
      expect(data.deviceId.value, 'device-9');
      expect(data.channelId, 'cctv');
    });

    test('rejects empty identifiers', () {
      expect(
        parseGuestJoinFields(partyId: '', deviceId: 'd', channelId: 'cctv'),
        isA<Err<GuestJoinData>>(),
      );
      expect(
        parseGuestJoinFields(partyId: 'p', deviceId: '   ', channelId: 'cctv'),
        isA<Err<GuestJoinData>>(),
      );
      expect(
        parseGuestJoinFields(partyId: 'p', deviceId: 'd', channelId: ''),
        isA<Err<GuestJoinData>>(),
      );
    });

    test('rejects path separators and URL shapes', () {
      expect(
        parseGuestJoinFields(
          partyId: 'party/1',
          deviceId: 'd',
          channelId: 'cctv',
        ),
        isA<Err<GuestJoinData>>(),
      );
      expect(
        parseGuestJoinFields(
          partyId: 'https://example.com',
          deviceId: 'd',
          channelId: 'cctv',
        ),
        isA<Err<GuestJoinData>>(),
      );
    });

    test('rejects overlong identifiers', () {
      final String tooLong = List.filled(kMaxBindingIdLength + 1, 'a').join();
      final Result<GuestJoinData> result = parseGuestJoinFields(
        partyId: tooLong,
        deviceId: 'd',
        channelId: 'cctv',
      );
      expect(result, isA<Err<GuestJoinData>>());
    });
  });

  group('parseGuestJoinPayload', () {
    test('accepts a pasted JSON object', () {
      final Result<GuestJoinData> result = parseGuestJoinPayload(
        '{"partyId": "party-1", "deviceId": "device-9", "channelId": "cctv"}',
      );
      expect(result, isA<Ok<GuestJoinData>>());
      expect(
        (result as Ok<GuestJoinData>).value,
        GuestJoinData(
          partyId: PartyId('party-1'),
          deviceId: DeviceId('device-9'),
          channelId: 'cctv',
        ),
      );
    });

    test('accepts snake_case keys and ignores extra keys', () {
      // Extra keys (backend selectors, URLs, executable content,
      // auto-submit flags) must be ignored — payload is data only.
      final Result<GuestJoinData> result = parseGuestJoinPayload(
        '{"party_id": "party-1", "device_id": "device-9", '
        '"channel_id": "cctv", "backend": "https://evil.example", '
        '"url": "https://evil.example/navigate", '
        '"autoSubmit": true, "script": "alert(1)"}',
      );
      expect(result, isA<Ok<GuestJoinData>>());
      final GuestJoinData data = (result as Ok<GuestJoinData>).value;
      expect(data.partyId.value, 'party-1');
      expect(data.channelId, 'cctv');
    });

    test('refuses to synthesize missing identifiers', () {
      expect(
        parseGuestJoinPayload('{"partyId": "party-1", "channelId": "cctv"}'),
        isA<Err<GuestJoinData>>(),
      );
      expect(parseGuestJoinPayload('{}'), isA<Err<GuestJoinData>>());
    });

    test('rejects bare URLs without navigation', () {
      expect(
        parseGuestJoinPayload('https://example.com/join?party=1'),
        isA<Err<GuestJoinData>>(),
      );
      expect(
        parseGuestJoinPayload('"https://example.com/join"'),
        isA<Err<GuestJoinData>>(),
      );
    });

    test('rejects malformed and non-object JSON', () {
      expect(parseGuestJoinPayload('{not json'), isA<Err<GuestJoinData>>());
      expect(parseGuestJoinPayload(''), isA<Err<GuestJoinData>>());
      expect(parseGuestJoinPayload('[1, 2, 3]'), isA<Err<GuestJoinData>>());
      expect(parseGuestJoinPayload('42'), isA<Err<GuestJoinData>>());
    });

    test('local validation never implies registration', () {
      // A well-formed payload parses fine, but parsing alone grants no
      // access — the server still decides FORBIDDEN at manifest-read time.
      final Result<GuestJoinData> result = parseGuestJoinPayload(
        '{"partyId": "ghost-party", "deviceId": "ghost-device", '
        '"channelId": "cctv"}',
      );
      expect(result, isA<Ok<GuestJoinData>>());
      expect((result as Ok<GuestJoinData>).value.partyId.value, 'ghost-party');
    });
  });
}
