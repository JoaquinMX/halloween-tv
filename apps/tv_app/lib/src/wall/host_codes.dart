/// Host invite QR data (TV settings panel, separately labelled HOST QR).
///
/// The TV mints a short-lived host invite through the host-only
/// `createHostInvite` callable and presents it as exactly one QR encoding
/// the scoped invite capability plus a 6-digit pairing code shown next to
/// the QR. The companion redeems them on its dedicated host entry screen
/// (Scan Host QR + an explicit Join-as-guest route) through `joinHost`,
/// which requires both the invite token and the pairing code; a wrong code
/// fails with the same generic denial as an unknown invite. Host
/// administration is never reachable through the guest PIN or a
/// client-supplied role string.
///
/// Host QR JSON (TV display, companion parse) contains exactly `partyId` +
/// `channelId` + `inviteToken` + `role` (`'host'`), plus the `pairingCode`
/// when minted (newer invites always carry it). It never carries a
/// deviceId (in particular never the TV device identity), URL, or secret.
/// Role examples live in `test/fixtures/join_roles_v1.json`.
library;

import 'dart:convert';

import 'package:cloud_functions/cloud_functions.dart';

import 'package:tv_app/src/wall/guest_codes.dart'
    show CallableInvoker, GuestCodeEntry, GuestCodeException, GuestCodeListing;

/// True when [value] looks like a server-minted host invite token.
///
/// Tokens are non-empty and never six ASCII digits: a guest PIN presented
/// where a token belongs is shape-rejected before it can cross the wire.
bool isValidHostInviteToken(String value) =>
    value.isNotEmpty && !RegExp(r'^[0-9]{6}$').hasMatch(value);

/// True when [value] is a 6-digit host pairing code (leading zeros
/// significant). The code is a short-lived second factor minted alongside
/// the invite token and shown next to the HOST QR; `joinHost` requires it
/// and wrong codes deny exactly like unknown invites.
bool isValidPairingCode(String value) => RegExp(r'^[0-9]{6}$').hasMatch(value);

/// Builds the host invite QR payload as a JSON object.
///
/// Contains exactly `partyId` + `channelId` + `inviteToken` + `role`
/// (`'host'`), plus `pairingCode` when [pairingCode] is non-null. Never
/// includes a deviceId. Throws [ArgumentError] when [inviteToken] is not a
/// plausible server-minted token (see [isValidHostInviteToken]) or when a
/// non-null [pairingCode] is not six ASCII digits.
String buildHostJoinPayload({
  required String partyId,
  required String channelId,
  required String inviteToken,
  String? pairingCode,
}) {
  if (!isValidHostInviteToken(inviteToken)) {
    throw ArgumentError.value(
      inviteToken,
      'inviteToken',
      'must be a server-minted host invite token',
    );
  }
  if (pairingCode != null && !isValidPairingCode(pairingCode)) {
    throw ArgumentError.value(
      pairingCode,
      'pairingCode',
      'must be six ASCII digits',
    );
  }
  final Map<String, String> payload = <String, String>{
    'partyId': partyId,
    'channelId': channelId,
    'inviteToken': inviteToken,
    'role': 'host',
  };
  if (pairingCode != null) {
    payload['pairingCode'] = pairingCode;
  }
  return jsonEncode(payload);
}

/// Failure minting or validating a host invite.
final class HostInviteException implements Exception {
  /// Creates a host-invite failure.
  const HostInviteException(this.message);

  /// Human-readable reason shown on the TV panel.
  final String message;

  @override
  String toString() => 'HostInviteException: $message';
}

/// A server-minted, short-lived host invite for this party + channel.
final class HostInvite {
  /// Creates an invite.
  const HostInvite({
    required this.partyId,
    required this.channelId,
    required this.inviteToken,
    required this.pairingCode,
    required this.expiresAt,
  });

  /// Party the invite is bound to.
  final String partyId;

  /// Channel the invite is bound to.
  final String channelId;

  /// Opaque invite capability (presented once as the QR payload).
  final String inviteToken;

  /// Six-digit pairing code shown next to the HOST QR and required by
  /// `joinHost` alongside [inviteToken].
  final String pairingCode;

  /// Server-stated expiry; the panel stops presenting the QR past it.
  final DateTime expiresAt;

  /// True when [now] is at or past [expiresAt].
  bool isExpired(DateTime now) => !now.isBefore(expiresAt);

  /// Validates a raw `createHostInvite` response against the requesting
  /// client's scope. Throws [HostInviteException] on any malformed field,
  /// including a missing or malformed pairing code.
  factory HostInvite.fromResponse(
    Map<String, Object?> data, {
    required String expectedPartyId,
    required String expectedChannelId,
  }) {
    final Object? partyId = data['partyId'];
    final Object? channelId = data['channelId'];
    final Object? inviteToken = data['inviteToken'];
    // Accept the snake_case spelling during the contract rollout; the
    // canonical wire key is `pairingCode`.
    final Object? pairingCode = data['pairingCode'] ?? data['pairing_code'];
    final Object? expiresAt = data['expiresAt'];
    if (partyId is! String || partyId.isEmpty) {
      throw const HostInviteException('Host invite response has no party.');
    }
    if (channelId is! String || channelId.isEmpty) {
      throw const HostInviteException('Host invite response has no channel.');
    }
    if (inviteToken is! String || !isValidHostInviteToken(inviteToken)) {
      throw const HostInviteException('Host invite token is malformed.');
    }
    if (pairingCode is! String || !isValidPairingCode(pairingCode)) {
      throw const HostInviteException('Host invite pairing code is malformed.');
    }
    if (partyId != expectedPartyId) {
      throw const HostInviteException('Host invite party mismatch.');
    }
    if (channelId != expectedChannelId) {
      throw const HostInviteException('Host invite channel mismatch.');
    }
    DateTime? expiry;
    if (expiresAt is String) {
      expiry = DateTime.tryParse(expiresAt);
    }
    if (expiry == null) {
      throw const HostInviteException('Host invite expiry is malformed.');
    }
    return HostInvite(
      partyId: partyId,
      channelId: channelId,
      inviteToken: inviteToken,
      pairingCode: pairingCode,
      expiresAt: expiry,
    );
  }
}

/// Reads the host-only `createHostInvite` callable (TV device only).
final class HostInviteClient {
  /// Creates a client over an invoker seam.
  const HostInviteClient({
    required this.invoker,
    required this.partyId,
    required this.deviceId,
    required this.channelId,
  });

  /// Builds a client over real Cloud Functions.
  factory HostInviteClient.cloudFunctions({
    required FirebaseFunctions functions,
    required String partyId,
    required String deviceId,
    required String channelId,
  }) => HostInviteClient(
    invoker: (String name, Map<String, Object?> payload) async {
      final HttpsCallableResult<Object?> result = await functions
          .httpsCallable(name)
          .call(payload);
      final Object? data = result.data;
      if (data is! Map) {
        throw const HostInviteException(
          'Host invite response was not an object.',
        );
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

  /// TV's own device code (the authorized host-invite minter).
  ///
  /// Authorization travels in the request only; the session QR never
  /// carries it.
  final String deviceId;

  /// Active channel.
  final String channelId;

  /// Mints a validated host invite bound to this party + channel.
  ///
  /// Throws [HostInviteException] when the response is malformed.
  /// Authorization failures surface as the caller's error.
  Future<HostInvite> createInvite() async {
    final Map<String, Object?> data = await invoker(
      'createHostInvite',
      <String, Object?>{
        'partyId': partyId,
        'deviceId': deviceId,
        'channelId': channelId,
      },
    );
    return HostInvite.fromResponse(
      data,
      expectedPartyId: partyId,
      expectedChannelId: channelId,
    );
  }
}

/// One active host device for the TV host-management list.
///
/// The panel renders [displayLabel] ONLY — the opaque [deviceId] never
/// reaches the screen (no credential leakage to anyone reading over a
/// shoulder). It is retained here solely so the revoke action can name its
/// target to the `revokeHostDevice` callable.
final class HostManagedDevice {
  /// Creates a host row.
  const HostManagedDevice({required this.deviceId, required this.displayLabel});

  /// Opaque device identity (revoke target; never rendered).
  final String deviceId;

  /// Neutral display label (never the device id).
  final String displayLabel;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is HostManagedDevice &&
          other.deviceId == deviceId &&
          other.displayLabel == displayLabel);

  @override
  int get hashCode => Object.hash(deviceId, displayLabel);

  @override
  String toString() => 'HostManagedDevice($displayLabel)';
}

/// Failure listing or revoking host devices.
final class HostDeviceException implements Exception {
  /// Creates a host-device failure.
  const HostDeviceException(this.message);

  /// Human-readable reason shown on the TV panel.
  final String message;

  @override
  String toString() => 'HostDeviceException: $message';
}

/// Reads the host-only `listPartyDevices` listing and revokes through the
/// TV-only `revokeHostDevice` callable.
///
/// The list surface is the same authorized `listPartyDevices` response the
/// guest panel reads (see [GuestCodeListing]); rows whose `role` is `host`
/// and whose `status` is `active` become label-only [HostManagedDevice]
/// rows. Revocation names only the opaque device id to the server.
final class HostDeviceClient {
  /// Creates a client over an invoker seam.
  const HostDeviceClient({
    required this.invoker,
    required this.partyId,
    required this.deviceId,
    required this.channelId,
  });

  /// Invoker seam (Cloud Functions in production, fake in tests).
  final CallableInvoker invoker;

  /// Party the TV belongs to.
  final String partyId;

  /// TV's own device code (the authorized caller).
  final String deviceId;

  /// Active channel.
  final String channelId;

  /// Lists active host devices as label-only rows (device ids retained
  /// internally as revoke targets, never rendered).
  ///
  /// Throws [HostDeviceException] when the response is malformed.
  /// Authorization failures surface as the caller's error.
  Future<List<HostManagedDevice>> listHosts() async {
    final Map<String, Object?> data = await invoker(
      'listPartyDevices',
      <String, Object?>{
        'partyId': partyId,
        'deviceId': deviceId,
        'channelId': channelId,
      },
    );
    late final GuestCodeListing listing;
    try {
      listing = GuestCodeListing.fromResponse(
        data,
        expectedPartyId: partyId,
        expectedChannelId: channelId,
        expectedTvDeviceId: deviceId,
      );
    } on GuestCodeException catch (error) {
      throw HostDeviceException(error.message);
    }
    final List<HostManagedDevice> hosts = <HostManagedDevice>[];
    for (final GuestCodeEntry entry in listing.devices) {
      if (entry.role != 'host' || entry.status != 'active') {
        continue;
      }
      hosts.add(
        HostManagedDevice(
          deviceId: entry.deviceId,
          displayLabel: entry.displayLabel,
        ),
      );
    }
    return hosts;
  }

  /// Revokes the host device [targetDeviceId] through the TV-only
  /// `revokeHostDevice` callable.
  ///
  /// Success is a non-error callable result whose echo (when the server
  /// includes one: `revokedDeviceId` or `deviceId`) names [targetDeviceId];
  /// a mismatched echo throws [HostDeviceException]. Authorization failures
  /// surface as the caller's error.
  Future<void> revokeHost(String targetDeviceId) async {
    if (targetDeviceId.isEmpty) {
      throw const HostDeviceException('Host revoke target is missing.');
    }
    final Map<String, Object?> data = await invoker(
      'revokeHostDevice',
      <String, Object?>{
        'partyId': partyId,
        'deviceId': deviceId,
        'channelId': channelId,
        'targetDeviceId': targetDeviceId,
      },
    );
    for (final String key in <String>['revokedDeviceId', 'deviceId']) {
      if (!data.containsKey(key)) {
        continue;
      }
      final Object? echo = data[key];
      if (echo is! String || echo != targetDeviceId) {
        throw const HostDeviceException('Host revoke echo mismatch.');
      }
      return;
    }
  }
}
