/// Anonymous guest join payload parsing.
library;

import 'dart:convert';
import 'package:core_foundation/core_foundation.dart';

const int kMaxBindingIdLength = 128;
final RegExp kBindingIdPattern = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]*$');
final RegExp _phoneId = RegExp(r'^p-[0-9a-f]{32}$');
final RegExp _pin = RegExp(r'^[0-9]{6}$');

final class GuestJoinData {
  final PartyId partyId;
  final DeviceId deviceId;
  final String channelId;
  final String? joinPin;
  const GuestJoinData({required this.partyId, required this.deviceId, required this.channelId, this.joinPin});
  Map<String, Object?> toJson() => <String, Object?>{'partyId': partyId.value, 'deviceId': deviceId.value, 'channelId': channelId, if (joinPin != null) 'joinPin': joinPin};
  @override
  bool operator ==(Object other) => other is GuestJoinData && other.partyId == partyId && other.deviceId == deviceId && other.channelId == channelId && other.joinPin == joinPin;
  @override
  int get hashCode => Object.hash(partyId, deviceId, channelId, joinPin);
  @override
  String toString() => 'GuestJoinData($partyId/$channelId@$deviceId)';
}

Result<String> _validate(String field, String raw) {
  final String value = raw.trim();
  if (value.isEmpty) return Err<String>('$field must be non-empty');
  if (value.length > kMaxBindingIdLength || !kBindingIdPattern.hasMatch(value)) return Err<String>('$field is malformed');
  return Ok<String>(value);
}

Result<GuestJoinData> parseGuestJoinFields({required String partyId, required String localDeviceId, required String channelId, String? joinPin}) {
  if (!_phoneId.hasMatch(localDeviceId)) return const Err<GuestJoinData>('local device identity is malformed');
  final party = _validate('partyId', partyId);
  if (party is Err<String>) return Err<GuestJoinData>(party.message);
  final channel = _validate('channelId', channelId);
  if (channel is Err<String>) return Err<GuestJoinData>(channel.message);
  final String? normalizedPin = joinPin?.trim().isEmpty ?? true ? null : joinPin!.trim();
  if (normalizedPin != null && !_pin.hasMatch(normalizedPin)) return const Err<GuestJoinData>('joinPin must contain exactly six digits');
  return Ok<GuestJoinData>(GuestJoinData(partyId: PartyId((party as Ok<String>).value), deviceId: DeviceId(localDeviceId), channelId: (channel as Ok<String>).value, joinPin: normalizedPin));
}

Result<GuestJoinData> parseGuestJoinPayload(String raw, {required String localDeviceId}) {
  final String trimmed = raw.trim();
  if (trimmed.isEmpty || RegExp(r'^(https?|javascript|data):', caseSensitive: false).hasMatch(trimmed)) return const Err<GuestJoinData>('join payload must be identifier data, not a URL');
  late final Object? decoded;
  try { decoded = jsonDecode(trimmed); } on FormatException { return const Err<GuestJoinData>('join payload is not valid JSON'); }
  if (decoded is! Map) return const Err<GuestJoinData>('join payload must be a JSON object');
  final Map<String, Object?> json = Map<String, Object?>.from(decoded.map((Object? k, Object? v) => MapEntry(k.toString(), v)));
  String? field(String key, String snake) { final value = json[key] ?? json[snake]; return value is String ? value : null; }
  final party = field('partyId', 'party_id');
  final channel = field('channelId', 'channel_id');
  final pinValue = json['joinPin'] ?? json['join_pin'];
  if (party == null || channel == null || (pinValue != null && pinValue is! String)) return const Err<GuestJoinData>('join payload must contain string partyId and channelId');
  return parseGuestJoinFields(partyId: party, localDeviceId: localDeviceId, channelId: channel, joinPin: pinValue as String?);
}
