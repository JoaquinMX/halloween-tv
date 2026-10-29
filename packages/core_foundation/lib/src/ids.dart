/// Strongly-typed party identifier.
final class PartyId {
  /// Raw id value; must be non-empty.
  final String value;

  PartyId(this.value) {
    if (value.trim().isEmpty) {
      throw ArgumentError.value(value, 'value', 'PartyId must be non-empty');
    }
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) || (other is PartyId && other.value == value);

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'PartyId($value)';
}

/// Strongly-typed device identifier.
final class DeviceId {
  /// Raw id value; must be non-empty.
  final String value;

  DeviceId(this.value) {
    if (value.trim().isEmpty) {
      throw ArgumentError.value(value, 'value', 'DeviceId must be non-empty');
    }
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) || (other is DeviceId && other.value == value);

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'DeviceId($value)';
}
