/// Provisioned anonymous TV identity used by party-scoped Firebase endpoints.
///
/// Values are supplied by the pilot seed or another trusted provisioning
/// path. This object is only an identifier bundle: the backend remains the
/// authority and rejects party/device pairs that are not active registrations.
/// No Firebase Auth uid, email, or login state is required by the TV.
library;

final RegExp _registeredIdShape = RegExp(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$');

final class FirebaseTvIdentity {
  FirebaseTvIdentity({required this.partyId, required this.deviceId}) {
    _validate(partyId, 'partyId');
    _validate(deviceId, 'deviceId');
  }

  final String partyId;
  final String deviceId;

  /// Identity fields shared by Firebase callable payloads.
  Map<String, Object?> callablePayload({required String channelId}) {
    _validate(channelId, 'channelId');
    return <String, Object?>{
      'partyId': partyId,
      'deviceId': deviceId,
      'channelId': channelId,
    };
  }

  static void _validate(String value, String field) {
    if (!_registeredIdShape.hasMatch(value)) {
      throw ArgumentError.value(
        value,
        field,
        'must be a provisioned id with letters, digits, _ or -',
      );
    }
  }
}
