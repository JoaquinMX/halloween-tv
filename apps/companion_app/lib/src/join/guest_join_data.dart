/// Anonymous join payload parsing with a validated host/guest role.
///
/// The TV renders two distinct QR capabilities, and the companion boots to a
/// dedicated host entry screen ([HostEntryScreen]) precisely so the two can
/// never be confused:
///
/// - Guest route (legacy-compatible): `{partyId, channelId, joinPin?}` with
///   NO `role` key. An absent role means **guest** so every payload printed
///   before roles existed keeps working.
/// - Host route: `{partyId, channelId, role: "host", inviteToken: "hi-…"}`
///   carrying the server-minted invite capability. The token is never a
///   six-digit guest PIN (PIN-shaped tokens are rejected, mirroring the
///   backend `parseJoinHostInput` gate) and a host payload never carries a
///   `joinPin`.
///
/// Any other `role` value (or a non-string role) fails visibly instead of
/// guessing, and malformed host capabilities (host without a valid invite
/// token, guest carrying an invite token) fail visibly too. Guest entry
/// must never register a host payload through `joinParty`: the join screens
/// route on [JoinRole] before any callable is invoked.
library;

import 'dart:convert';
import 'package:core_foundation/core_foundation.dart';

const int kMaxBindingIdLength = 128;
final RegExp kBindingIdPattern = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]*$');
final RegExp _phoneId = RegExp(r'^p-[0-9a-f]{32}$');
final RegExp _pin = RegExp(r'^[0-9]{6}$');

/// Server-assigned device role carried by a join payload.
///
/// Clients can never self-assign privilege: this only selects which
/// redemption callable (`joinParty` vs `joinHost`) the payload is routed to,
/// and the backend assigns the actual role server-side.
enum JoinRole { guest, host }

final class GuestJoinData {
  final PartyId partyId;
  final DeviceId deviceId;
  final String channelId;
  final String? joinPin;
  final JoinRole role;
  final String? inviteToken;
  const GuestJoinData({
    required this.partyId,
    required this.deviceId,
    required this.channelId,
    this.joinPin,
    this.role = JoinRole.guest,
    this.inviteToken,
  });
  @override
  bool operator ==(Object other) =>
      other is GuestJoinData &&
      other.partyId == partyId &&
      other.deviceId == deviceId &&
      other.channelId == channelId &&
      other.joinPin == joinPin &&
      other.role == role &&
      other.inviteToken == inviteToken;
  @override
  int get hashCode =>
      Object.hash(partyId, deviceId, channelId, joinPin, role, inviteToken);
  @override
  String toString() =>
      'GuestJoinData($partyId/$channelId@$deviceId role=$role)';
}

Result<String> _validate(String field, String raw) {
  final String value = raw.trim();
  if (value.isEmpty) return Err<String>('$field must be non-empty');
  if (value.length > kMaxBindingIdLength ||
      !kBindingIdPattern.hasMatch(value)) {
    return Err<String>('$field is malformed');
  }
  return Ok<String>(value);
}

/// Validates a host invite capability (never a guest PIN).
///
/// Mirrors the backend `parseJoinHostInput` gate: the token is a
/// server-minted capability, so a six-digit PIN shape is rejected here
/// instead of consuming a host redemption attempt.
Result<String> _validateInviteToken(String? raw) {
  if (raw == null || raw.trim().isEmpty) {
    return const Err<String>('host inviteToken is required');
  }
  final String value = raw.trim();
  if (value.length > 256) {
    return const Err<String>('host inviteToken is invalid');
  }
  if (_pin.hasMatch(value)) {
    return const Err<String>(
      'inviteToken must be a host invite, not a guest PIN',
    );
  }
  return Ok<String>(value);
}

Result<GuestJoinData> parseGuestJoinFields({
  required String partyId,
  required String localDeviceId,
  required String channelId,
  String? joinPin,
  JoinRole role = JoinRole.guest,
  String? inviteToken,
}) {
  if (!_phoneId.hasMatch(localDeviceId)) {
    return const Err<GuestJoinData>('local device identity is malformed');
  }
  final party = _validate('partyId', partyId);
  if (party is Err<String>) return Err<GuestJoinData>(party.message);
  final channel = _validate('channelId', channelId);
  if (channel is Err<String>) return Err<GuestJoinData>(channel.message);
  if (role == JoinRole.host) {
    if (joinPin != null && joinPin.trim().isNotEmpty) {
      return const Err<GuestJoinData>(
        'host join must carry an inviteToken, not a joinPin',
      );
    }
    final token = _validateInviteToken(inviteToken);
    if (token is Err<String>) return Err<GuestJoinData>(token.message);
    return Ok<GuestJoinData>(
      GuestJoinData(
        partyId: PartyId((party as Ok<String>).value),
        deviceId: DeviceId(localDeviceId),
        channelId: (channel as Ok<String>).value,
        role: JoinRole.host,
        inviteToken: (token as Ok<String>).value,
      ),
    );
  }
  if (inviteToken != null && inviteToken.trim().isNotEmpty) {
    return const Err<GuestJoinData>(
      'guest join must not carry a host inviteToken',
    );
  }
  final String? normalizedPin = joinPin?.trim().isEmpty ?? true
      ? null
      : joinPin!.trim();
  if (normalizedPin != null && !_pin.hasMatch(normalizedPin)) {
    return const Err<GuestJoinData>('joinPin must contain exactly six digits');
  }
  return Ok<GuestJoinData>(
    GuestJoinData(
      partyId: PartyId((party as Ok<String>).value),
      deviceId: DeviceId(localDeviceId),
      channelId: (channel as Ok<String>).value,
      joinPin: normalizedPin,
    ),
  );
}

/// Convenience for the host entry form: a host-typed field set.
Result<GuestJoinData> parseHostJoinFields({
  required String partyId,
  required String localDeviceId,
  required String channelId,
  required String inviteToken,
}) => parseGuestJoinFields(
  partyId: partyId,
  localDeviceId: localDeviceId,
  channelId: channelId,
  role: JoinRole.host,
  inviteToken: inviteToken,
);

/// Parses a scanned or pasted join payload through the shared validator.
///
/// Scan and paste stay in parity: both funnel here. An absent `role` means
/// guest (legacy payloads); `role: "guest"` is explicit guest;
/// `role: "host"` requires a valid `inviteToken`. Unknown roles, non-string
/// roles, and malformed host capabilities fail visibly.
Result<GuestJoinData> parseGuestJoinPayload(
  String raw, {
  required String localDeviceId,
}) {
  final String trimmed = raw.trim();
  if (trimmed.isEmpty ||
      RegExp(
        r'^(https?|javascript|data):',
        caseSensitive: false,
      ).hasMatch(trimmed)) {
    return const Err<GuestJoinData>(
      'join payload must be identifier data, not a URL',
    );
  }
  late final Object? decoded;
  try {
    decoded = jsonDecode(trimmed);
  } on FormatException {
    return const Err<GuestJoinData>('join payload is not valid JSON');
  }
  if (decoded is! Map) {
    return const Err<GuestJoinData>('join payload must be a JSON object');
  }
  final Map<String, Object?> json = Map<String, Object?>.from(
    decoded.map((Object? k, Object? v) => MapEntry(k.toString(), v)),
  );
  String? field(String key, String snake) {
    final value = json[key] ?? json[snake];
    return value is String ? value : null;
  }

  JoinRole role = JoinRole.guest;
  if (json.containsKey('role')) {
    final Object? rawRole = json['role'];
    if (rawRole is! String) {
      return const Err<GuestJoinData>(
        'join payload role must be "guest" or "host"',
      );
    }
    switch (rawRole.trim()) {
      case 'guest':
        role = JoinRole.guest;
      case 'host':
        role = JoinRole.host;
      default:
        return Err<GuestJoinData>(
          'join payload has unknown role "${rawRole.trim()}"',
        );
    }
  }

  final party = field('partyId', 'party_id');
  final channel = field('channelId', 'channel_id');
  final pinValue = json['joinPin'] ?? json['join_pin'];
  // A present-but-non-string PIN is a PIN error, not an identifier error.
  if (pinValue != null && pinValue is! String) {
    return const Err<GuestJoinData>('joinPin must contain exactly six digits');
  }
  if (party == null || channel == null) {
    return const Err<GuestJoinData>(
      'join payload must contain string partyId and channelId',
    );
  }
  String? inviteToken;
  if (json.containsKey('inviteToken') || json.containsKey('invite_token')) {
    final Object? rawToken = json['inviteToken'] ?? json['invite_token'];
    if (rawToken is! String) {
      return const Err<GuestJoinData>('host inviteToken must be a string');
    }
    inviteToken = rawToken;
  }
  return parseGuestJoinFields(
    partyId: party,
    localDeviceId: localDeviceId,
    channelId: channel,
    joinPin: pinValue as String?,
    role: role,
    inviteToken: inviteToken,
  );
}
