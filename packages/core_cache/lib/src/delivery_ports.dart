/// Delivery acknowledgement contract used after durable local verification.
library;

/// Acknowledges a fully stored and validated manifest delivery.
abstract interface class DeliveryAcknowledger {
  /// Confirms [manifestVersion] after every declared clip is verified locally.
  ///
  /// [verifiedClipHashes] contains the SHA-256 digest for each clip in
  /// manifest order. Implementations bind the values to the party, channel,
  /// and version supplied here.
  Future<void> acknowledge({
    required String partyId,
    required String channelId,
    required int manifestVersion,
    required List<String> verifiedClipHashes,
  });
}
