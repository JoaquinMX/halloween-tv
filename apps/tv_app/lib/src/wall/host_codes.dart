/// Host invite QR data (TV settings panel, separately labelled HOST QR).
///
/// The TV mints a short-lived host invite through the host-only
/// `createHostInvite` callable and presents it as exactly one QR encoding
/// the scoped invite capability. The companion redeems it on its dedicated
/// host entry screen (Scan Host QR + an explicit Join-as-guest route), so
/// host administration is never reachable through the guest PIN or a
/// client-supplied role string.
///
/// Host QR JSON (TV display, companion parse) contains exactly `partyId` +
/// `channelId` + `inviteToken` + `role` (`'host'`). It never carries a
/// deviceId (in particular never the TV device identity), URL, or secret.
/// Role examples live in `test/fixtures/join_roles_v1.json`.
library;

import 'dart:convert';

import 'package:cloud_functions/cloud_functions.dart';

import 'package:tv_app/src/wall/guest_codes.dart' show CallableInvoker;

/// True when [value] looks like a server-minted host invite token.
///
/// Tokens are non-empty and never six ASCII digits: a guest PIN presented
/// where a token belongs is shape-rejected before it can cross the wire.
bool isValidHostInviteToken(String value) =>
    value.isNotEmpty && !RegExp(r'^[0-9]{6}$').hasMatch(value);

/// Builds the host invite QR payload as a JSON object.
///
/// Contains exactly `partyId` + `channelId` + `inviteToken` + `role`
/// (`'host'`). Never includes a deviceId. Throws [ArgumentError] when
/// [inviteToken] is not a plausible server-minted token (see
/// [isValidHostInviteToken]).
String buildHostJoinPayload({
  required String partyId,
  required String channelId,
  required String inviteToken,
}) {
  if (!isValidHostInviteToken(inviteToken)) {
    throw ArgumentError.value(
      inviteToken,
      'inviteToken',
      'must be a server-minted host invite token',
    );
  }
  return jsonEncode(<String, String>{
    'partyId': partyId,
    'channelId': channelId,
    'inviteToken': inviteToken,
    'role': 'host',
  });
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
    required this.expiresAt,
  });

  /// Party the invite is bound to.
  final String partyId;

  /// Channel the invite is bound to.
  final String channelId;

  /// Opaque invite capability (presented once as the QR payload).
  final String inviteToken;

  /// Server-stated expiry; the panel stops presenting the QR past it.
  final DateTime expiresAt;

  /// True when [now] is at or past [expiresAt].
  bool isExpired(DateTime now) => !now.isBefore(expiresAt);

  /// Validates a raw `createHostInvite` response against the requesting
  /// client's scope. Throws [HostInviteException] on any malformed field.
  factory HostInvite.fromResponse(
    Map<String, Object?> data, {
    required String expectedPartyId,
    required String expectedChannelId,
  }) {
    final Object? partyId = data['partyId'];
    final Object? channelId = data['channelId'];
    final Object? inviteToken = data['inviteToken'];
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
