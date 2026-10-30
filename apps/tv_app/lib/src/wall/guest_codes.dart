/// Host-visible guest code data (TV settings panel).
///
/// The TV panel shows the TV's own party/device code as large text plus a QR
/// encoding the anonymous session join payload, and lists the joined guest
/// devices. Identifiers are opaque binding values only — never URLs,
/// endpoints, or secrets. Registration is always decided server-side at
/// callable time; nothing here implies a code is valid.
///
/// Session QR JSON (TV display, companion parse) contains exactly
/// `partyId` + `channelId` plus optional six-digit `joinPin`. It never
/// carries a deviceId, URL, or secret.
library;

import 'dart:convert';

import 'package:cloud_functions/cloud_functions.dart';

/// Validates the optional six-digit session PIN (leading zeros significant).
bool isValidJoinPin(String value) =>
    RegExp(r'^[0-9]{6}$').hasMatch(value);

/// One per-guest device visible to the host.
///
/// Self-registered guests may have no `label` (absent or empty on the wire);
/// readers must fall back to a neutral device-based display, never duplicate
/// the id as label+value, and never prompt for names.
final class GuestCodeEntry {
  /// Creates a guest code row.
  const GuestCodeEntry({
    required this.deviceId,
    this.label,
    this.role,
    this.status,
  });

  /// Guest device id (opaque value shown once as the row value).
  final String deviceId;

  /// Host label when the backend supplied a non-empty one; null otherwise.
  final String? label;

  /// Device role as reported by the listing (e.g. "guest"); null when absent.
  final String? role;

  /// Device status as reported by the listing; null when absent.
  final String? status;

  /// True when the backend supplied a non-blank label.
  bool get hasCustomLabel => label != null && label!.trim().isNotEmpty;

  /// Neutral display label: the custom label when present, else a generic
  /// fallback that never echoes the device id.
  String get displayLabel =>
      hasCustomLabel ? label!.trim() : 'Guest device';

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is GuestCodeEntry &&
          other.deviceId == deviceId &&
          other.label == label &&
          other.role == role &&
          other.status == status);

  @override
  int get hashCode => Object.hash(deviceId, label, role, status);

  @override
  String toString() => 'GuestCodeEntry($displayLabel: $deviceId)';
}

/// Builds the anonymous session QR/join payload as a JSON object.
///
/// Contains exactly `partyId` + `channelId` plus the optional six-digit
/// `joinPin` (omitted when null). Never includes a deviceId, URL, or secret.
/// Throws [ArgumentError] when [joinPin] is non-null but malformed.
String buildJoinPayload({
  required String partyId,
  required String channelId,
  String? joinPin,
}) {
  if (joinPin != null && !isValidJoinPin(joinPin)) {
    throw ArgumentError.value(joinPin, 'joinPin', 'must be six ASCII digits');
  }
  final Map<String, String> payload = <String, String>{
    'partyId': partyId,
    'channelId': channelId,
  };
  if (joinPin != null) {
    payload['joinPin'] = joinPin;
  }
  return jsonEncode(payload);
}

/// Failure reading the host guest-code listing.
final class GuestCodeException implements Exception {
  /// Creates a guest-code read failure.
  const GuestCodeException(this.message);

  /// Human-readable reason shown on the TV panel.
  final String message;

  @override
  String toString() => 'GuestCodeException: $message';
}

/// Callable invoker seam: calls the named callable with the payload and
/// returns the decoded response data. Production passes Cloud Functions;
/// tests pass a fake.
typedef CallableInvoker =
    Future<Map<String, Object?>> Function(
      String name,
      Map<String, Object?> payload,
    );

/// Validated host-only session listing from `listPartyDevices`.
///
/// Carries the authoritative session scope (`partyId`/`channelId`/
/// `tvDeviceId`), the optional `joinPin` (string when configured, absent
/// otherwise), and the guest device entries. PIN state always comes from
/// this response, never from build-time config.
final class GuestCodeListing {
  /// Creates a validated listing.
  const GuestCodeListing({
    required this.partyId,
    required this.channelId,
    required this.tvDeviceId,
    required this.devices,
    this.joinPin,
  });

  /// Party the TV belongs to (must match the requesting client).
  final String partyId;

  /// Active channel (must match the requesting client).
  final String channelId;

  /// TV's own device id (must match the requesting client).
  final String tvDeviceId;

  /// Session PIN when configured; null means no PIN is required.
  final String? joinPin;

  /// Guest device entries (TV's own device excluded server-side).
  final List<GuestCodeEntry> devices;

  /// Validates a raw callable response against the requesting client's
  /// scope. Throws [GuestCodeException] on any malformed field.
  factory GuestCodeListing.fromResponse(
    Map<String, Object?> data, {
    required String expectedPartyId,
    required String expectedChannelId,
    required String expectedTvDeviceId,
  }) {
    final Object? partyId = data['partyId'];
    final Object? channelId = data['channelId'];
    final Object? tvDeviceId = data['tvDeviceId'] ?? data['deviceId'];
    if (partyId is! String || partyId.isEmpty) {
      throw const GuestCodeException('Guest list response has no party.');
    }
    if (channelId is! String || channelId.isEmpty) {
      throw const GuestCodeException('Guest list response has no channel.');
    }
    if (tvDeviceId is! String || tvDeviceId.isEmpty) {
      throw const GuestCodeException('Guest list response has no TV device.');
    }
    if (partyId != expectedPartyId) {
      throw const GuestCodeException('Guest list party mismatch.');
    }
    if (channelId != expectedChannelId) {
      throw const GuestCodeException('Guest list channel mismatch.');
    }
    if (tvDeviceId != expectedTvDeviceId) {
      throw const GuestCodeException('Guest list TV device mismatch.');
    }
    String? joinPin;
    if (data.containsKey('joinPin')) {
      final Object? rawPin = data['joinPin'];
      if (rawPin == null) {
        joinPin = null;
      } else if (rawPin is String && isValidJoinPin(rawPin)) {
        joinPin = rawPin;
      } else {
        throw const GuestCodeException('Guest list PIN is malformed.');
      }
    }
    final Object? devices = data['devices'];
    if (devices is! List) {
      throw const GuestCodeException('Guest list response has no device list.');
    }
    final List<GuestCodeEntry> entries = <GuestCodeEntry>[];
    for (final Object? item in devices) {
      if (item is! Map) {
        throw const GuestCodeException('Guest list entry was not an object.');
      }
      final Map<String, Object?> row = Map<String, Object?>.from(item);
      final Object? deviceId = row['deviceId'];
      if (deviceId is! String || deviceId.isEmpty) {
        throw const GuestCodeException('Guest list entry is missing fields.');
      }
      String? label;
      if (row.containsKey('label')) {
        final Object? rawLabel = row['label'];
        if (rawLabel == null) {
          label = null;
        } else if (rawLabel is String) {
          label = rawLabel.trim().isEmpty ? null : rawLabel.trim();
        } else {
          throw const GuestCodeException(
            'Guest list entry is missing fields.',
          );
        }
      }
      String? role;
      if (row.containsKey('role')) {
        final Object? rawRole = row['role'];
        if (rawRole == null) {
          role = null;
        } else if (rawRole is String && rawRole.isNotEmpty) {
          role = rawRole;
        } else {
          throw const GuestCodeException(
            'Guest list entry is missing fields.',
          );
        }
      }
      String? status;
      if (row.containsKey('status')) {
        final Object? rawStatus = row['status'];
        if (rawStatus == null) {
          status = null;
        } else if (rawStatus is String && rawStatus.isNotEmpty) {
          status = rawStatus;
        } else {
          throw const GuestCodeException(
            'Guest list entry is missing fields.',
          );
        }
      }
      entries.add(
        GuestCodeEntry(
          deviceId: deviceId,
          label: label,
          role: role,
          status: status,
        ),
      );
    }
    return GuestCodeListing(
      partyId: partyId,
      channelId: channelId,
      tvDeviceId: tvDeviceId,
      joinPin: joinPin,
      devices: List<GuestCodeEntry>.unmodifiable(entries),
    );
  }
}

/// Reads the host-only `listPartyDevices` callable (TV device only).
final class GuestCodeClient {
  /// Creates a client over an invoker seam.
  const GuestCodeClient({
    required this.invoker,
    required this.partyId,
    required this.deviceId,
    required this.channelId,
  });

  /// Builds a client over real Cloud Functions.
  factory GuestCodeClient.cloudFunctions({
    required FirebaseFunctions functions,
    required String partyId,
    required String deviceId,
    required String channelId,
  }) => GuestCodeClient(
    invoker: (String name, Map<String, Object?> payload) async {
      final HttpsCallableResult<Object?> result = await functions
          .httpsCallable(name)
          .call(payload);
      final Object? data = result.data;
      if (data is! Map) {
        throw const GuestCodeException('Guest list response was not an object.');
      }
      return Map<String, Object?>.from(data);
    },
    partyId: partyId,
    deviceId: deviceId,
    channelId: channelId,
  );

  /// Invoker seam (Cloud Functions in production, fake in tests).
  final CallableInvoker invoker;

  /// Party the TV belongs to.
  final String partyId;

  /// TV's own device code (the authorized host caller).
  final String deviceId;

  /// Active channel.
  final String channelId;

  /// Fetches the validated host listing (scope + optional PIN + devices).
  ///
  /// Authorization still travels in the request as the TV's own `deviceId`;
  /// the session QR never carries it. Throws [GuestCodeException] when the
  /// response is malformed. Authorization failures surface as the caller's
  /// error.
  Future<GuestCodeListing> fetchListing() async {
    final Map<String, Object?> data = await invoker('listPartyDevices', <
      String,
      Object?
    >{
      'partyId': partyId,
      'deviceId': deviceId,
      'channelId': channelId,
    });
    return GuestCodeListing.fromResponse(
      data,
      expectedPartyId: partyId,
      expectedChannelId: channelId,
      expectedTvDeviceId: deviceId,
    );
  }

  /// Fetches guest codes; throws [GuestCodeException] when the response is
  /// malformed. Authorization failures surface as the caller's error.
  Future<List<GuestCodeEntry>> fetchGuestCodes() async {
    final GuestCodeListing listing = await fetchListing();
    return listing.devices;
  }
}
