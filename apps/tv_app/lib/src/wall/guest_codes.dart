/// Host-visible guest code data (TV settings panel).
///
/// The TV panel shows the TV's own party/device code as large text plus a QR
/// encoding the anonymous join payload, and lists the per-guest device codes
/// the host dictates verbally. Identifiers are opaque binding values only —
/// never URLs, endpoints, or secrets. Registration is always decided
/// server-side at callable time; nothing here implies a code is valid.
library;

import 'dart:convert';

import 'package:cloud_functions/cloud_functions.dart';

/// One per-guest device code visible to the host.
final class GuestCodeEntry {
  /// Creates a guest code row.
  const GuestCodeEntry({required this.deviceId, required this.label});

  /// Guest device code (dictated verbally to the guest).
  final String deviceId;

  /// Host label (e.g. "Guest 1").
  final String label;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is GuestCodeEntry &&
          other.deviceId == deviceId &&
          other.label == label);

  @override
  int get hashCode => Object.hash(deviceId, label);

  @override
  String toString() => 'GuestCodeEntry($label: $deviceId)';
}

/// Builds the QR/join payload: the TV's own identifiers as a JSON object.
///
/// Shape matches the companion's accepted join payload (`partyId`,
/// `deviceId`, `channelId`); extra keys are never added. QR scanning lands
/// in a later slice — today the panel is display-only.
String buildJoinPayload({
  required String partyId,
  required String deviceId,
  required String channelId,
}) => jsonEncode(<String, String>{
  'partyId': partyId,
  'deviceId': deviceId,
  'channelId': channelId,
});

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

  /// Fetches guest codes; throws [GuestCodeException] when the response is
  /// malformed. Authorization failures surface as the caller's error.
  Future<List<GuestCodeEntry>> fetchGuestCodes() async {
    final Map<String, Object?> data = await invoker('listPartyDevices', <
      String,
      Object?
    >{
      'partyId': partyId,
      'deviceId': deviceId,
      'channelId': channelId,
    });
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
      final Object? label = row['label'];
      if (deviceId is! String ||
          deviceId.isEmpty ||
          label is! String ||
          label.isEmpty) {
        throw const GuestCodeException('Guest list entry is missing fields.');
      }
      entries.add(GuestCodeEntry(deviceId: deviceId, label: label));
    }
    return entries;
  }
}
