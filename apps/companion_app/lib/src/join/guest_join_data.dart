/// Anonymous guest join payload parsing (data only, never registration).
///
/// The guest join flow is anonymous: there is no login, no Firebase Auth uid,
/// and no server round-trip here. These helpers parse either manually entered
/// `partyId`/`deviceId`/`channelId` fields or a pasted JSON object carrying
/// those identifiers, and validate them locally as binding identifiers.
///
/// Security posture (binding constraint):
/// - The payload is treated exclusively as data. Extra keys (URLs, endpoints,
///   backend selectors, executable content, auto-submit flags) are ignored
///   and never acted upon. No URL navigation or network call is performed.
/// - Entries are trimmed; binding identifier syntax and length are enforced;
///   the [PartyId]/[DeviceId] value types are reused for party/device.
/// - Local validation NEVER implies registration: a successful parse only
///   means the identifiers are well-formed. The server still decides
///   `FORBIDDEN`/`UNAUTHENTICATED` at manifest-read time.
library;

import 'dart:convert';

import 'package:core_foundation/core_foundation.dart';

/// Maximum accepted length for any single binding identifier.
const int kMaxBindingIdLength = 128;

/// Binding identifiers are single path segments: they must start with an
/// alphanumeric and may then contain alphanumerics, `.`, `_`, or `-`.
/// This rejects `/`, whitespace, control characters, and URL shapes.
final RegExp kBindingIdPattern = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]*$');

/// Validated anonymous join identifiers.
///
/// Well-formed only — never proof of registration.
final class GuestJoinData {
  /// Party binding (reuses the shared [PartyId] value type).
  final PartyId partyId;

  /// Device binding (reuses the shared [DeviceId] value type).
  final DeviceId deviceId;

  /// Channel binding (single path segment, e.g. `cctv`).
  final String channelId;

  const GuestJoinData({
    required this.partyId,
    required this.deviceId,
    required this.channelId,
  });

  /// Serializes back to plain data (no executable content).
  Map<String, Object?> toJson() => <String, Object?>{
    'partyId': partyId.value,
    'deviceId': deviceId.value,
    'channelId': channelId,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is GuestJoinData &&
          other.partyId == partyId &&
          other.deviceId == deviceId &&
          other.channelId == channelId);

  @override
  int get hashCode => Object.hash(partyId, deviceId, channelId);

  @override
  String toString() => 'GuestJoinData($partyId/$channelId@$deviceId)';
}

/// Validates one binding identifier after trimming.
Result<String> _validateBindingId(String field, String raw) {
  final String trimmed = raw.trim();
  if (trimmed.isEmpty) {
    return Err<String>('$field must be non-empty');
  }
  if (trimmed.length > kMaxBindingIdLength) {
    return Err<String>('$field exceeds $kMaxBindingIdLength characters');
  }
  if (!kBindingIdPattern.hasMatch(trimmed)) {
    return Err<String>(
      '$field must be a single path segment '
      '(letter/digit start, then letters, digits, dot, dash, underscore)',
    );
  }
  return Ok<String>(trimmed);
}

/// Parses manually entered join fields.
///
/// Trims each entry and enforces binding identifier syntax/length.
/// Never synthesizes missing identifiers: every field is required.
Result<GuestJoinData> parseGuestJoinFields({
  required String partyId,
  required String deviceId,
  required String channelId,
}) {
  final Result<String> party = _validateBindingId('partyId', partyId);
  if (party is Err<String>) {
    return Err<GuestJoinData>(party.message);
  }
  final Result<String> device = _validateBindingId('deviceId', deviceId);
  if (device is Err<String>) {
    return Err<GuestJoinData>(device.message);
  }
  final Result<String> channel = _validateBindingId('channelId', channelId);
  if (channel is Err<String>) {
    return Err<GuestJoinData>(channel.message);
  }
  return Ok<GuestJoinData>(
    GuestJoinData(
      partyId: PartyId((party as Ok<String>).value),
      deviceId: DeviceId((device as Ok<String>).value),
      channelId: (channel as Ok<String>).value,
    ),
  );
}

/// Reads an identifier from a decoded JSON object.
///
/// Accepts both `camelCase` and `snake_case` spellings for the three
/// identifier keys. Returns `null` when the key is absent or not a string —
/// callers report that as missing (never synthesized).
String? _stringField(Map<String, Object?> json, String camel, String snake) {
  final Object? direct = json[camel] ?? json[snake];
  if (direct is String) {
    return direct;
  }
  return null;
}

/// Parses a pasted JSON object containing the join identifiers.
///
/// The payload is data only: it must decode to a JSON object with string
/// `partyId`/`deviceId`/`channelId` entries (snake_case accepted). All other
/// keys — URLs, endpoints, backend selectors, executable content,
/// auto-submit flags — are ignored. Bare URLs, arrays, and non-object
/// payloads are rejected without navigation or network traffic.
Result<GuestJoinData> parseGuestJoinPayload(String raw) {
  final String trimmed = raw.trim();
  if (trimmed.isEmpty) {
    return const Err<GuestJoinData>('join payload must be non-empty');
  }
  final String lowered = trimmed.toLowerCase();
  if (lowered.startsWith('http://') ||
      lowered.startsWith('https://') ||
      lowered.startsWith('javascript:') ||
      lowered.startsWith('data:')) {
    return const Err<GuestJoinData>(
      'join payload must be identifier data, not a URL',
    );
  }
  late final Object? decoded;
  try {
    decoded = jsonDecode(trimmed);
  } on FormatException catch (error) {
    return Err<GuestJoinData>(
      'join payload is not valid JSON: ${error.message}',
    );
  }
  if (decoded is String) {
    final String inner = decoded.trim().toLowerCase();
    if (inner.startsWith('http://') || inner.startsWith('https://')) {
      return const Err<GuestJoinData>(
        'join payload must be identifier data, not a URL',
      );
    }
    return const Err<GuestJoinData>(
      'join payload must be a JSON object with partyId, deviceId, channelId',
    );
  }
  if (decoded is! Map) {
    return const Err<GuestJoinData>(
      'join payload must be a JSON object with partyId, deviceId, channelId',
    );
  }
  late final Map<String, Object?> json;
  try {
    json = Map<String, Object?>.from(
      decoded.map(
        (Object? key, Object? value) => MapEntry(key.toString(), value),
      ),
    );
  } on Object {
    return const Err<GuestJoinData>(
      'join payload must be a JSON object with partyId, deviceId, channelId',
    );
  }
  final String? party = _stringField(json, 'partyId', 'party_id');
  final String? device = _stringField(json, 'deviceId', 'device_id');
  final String? channel = _stringField(json, 'channelId', 'channel_id');
  if (party == null || device == null || channel == null) {
    return const Err<GuestJoinData>(
      'join payload must contain string partyId, deviceId, and channelId '
      '(missing identifiers are never synthesized)',
    );
  }
  // All remaining keys are deliberately ignored: no URL navigation, no
  // backend selection, no executable content, no auto-submit.
  return parseGuestJoinFields(
    partyId: party,
    deviceId: device,
    channelId: channel,
  );
}
