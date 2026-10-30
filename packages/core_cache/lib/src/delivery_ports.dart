/// Delivery acknowledgement contract used after durable local verification.
library;

/// Acknowledges a fully stored and validated manifest delivery.
abstract interface class DeliveryAcknowledger {
  /// Confirms [manifestVersion] after every declared clip is verified locally.
  ///
  /// [verifiedClipHashes] maps each camera id to its verified SHA-256 digest.
  /// Implementations bind the values to the party, channel, and version
  /// supplied here.
  Future<void> acknowledge({
    required String partyId,
    required String channelId,
    required int manifestVersion,
    required Map<String, String> verifiedClipHashes,
  });
}
