import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:logging/logging.dart';

import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';

/// Firestore implementation of the playlist port.
class FirestorePlaylistAdapter implements PlaylistPort {
  FirestorePlaylistAdapter({FirebaseFirestore? firestore})
      : _firestore = firestore ?? FirebaseFirestore.instance,
        _logger = AppLogger.create('FirestorePlaylistAdapter');

  final FirebaseFirestore _firestore;
  final Logger _logger;

  @override
  Stream<Playlist> watchCurrent(String partyId) {
    final DocumentReference<Map<String, dynamic>> doc =
        _firestore.collection('parties').doc(partyId).collection('playlist').doc('current');
    return doc.snapshots().map((DocumentSnapshot<Map<String, dynamic>> snapshot) {
      if (!snapshot.exists) {
        throw ValidationFailure('Playlist document missing for party $partyId');
      }
      try {
        return _mapPlaylist(snapshot.data()!);
      } on Failure catch (failure) {
        _logger.warning('Playlist mapping failure', failure, failure.stackTrace);
        rethrow;
      }
    });
  }

  Playlist _mapPlaylist(Map<String, dynamic> data) {
    final int? version = data['version'] as int?;
    if (version == null) {
      throw ValidationFailure('Playlist version missing');
    }
    final Timestamp? expiresAtRaw = data['expiresAt'] as Timestamp?;
    if (expiresAtRaw == null) {
      throw ValidationFailure('Playlist expiresAt missing');
    }
    final Map<String, dynamic>? overlayRaw = data['overlay'] as Map<String, dynamic>?;
    if (overlayRaw == null) {
      throw ValidationFailure('Playlist overlay missing');
    }
    final String? timestampFmt = overlayRaw['timestampFmt'] as String?;
    final num? glitchIntensity = overlayRaw['glitchIntensity'] as num?;
    if (timestampFmt == null || glitchIntensity == null) {
      throw ValidationFailure('Overlay missing required fields');
    }

    final List<dynamic>? clipsRaw = data['clips'] as List<dynamic>?;
    if (clipsRaw == null || clipsRaw.length != CoreConstants.requiredClipCount) {
      throw ValidationFailure('Playlist must contain four clips');
    }
    final List<ClipItem> clips = clipsRaw.map((dynamic item) {
      if (item is! Map<String, dynamic>) {
        throw ValidationFailure('Clip entry must be a map');
      }
      final String? id = item['id'] as String?;
      final String? label = item['label'] as String?;
      final String? localKey = item['localKey'] as String?;
      final String? signedUrl = item['signedUrl'] as String?;
      final String? checksum = item['checksumSha256'] as String?;
      final int? sizeBytes = item['sizeBytes'] as int?;
      if (id == null || label == null || localKey == null || signedUrl == null || checksum == null || sizeBytes == null) {
        throw ValidationFailure('Clip entry missing fields');
      }
      return ClipItem(
        id: id,
        label: label,
        localKey: localKey,
        signedUrl: signedUrl,
        checksumSha256: checksum,
        sizeBytes: sizeBytes,
      );
    }).toList(growable: false);

    return Playlist(
      version: version,
      clips: clips,
      overlay: OverlayConfig(timestampFmt: timestampFmt, glitchIntensity: glitchIntensity.toDouble()),
      expiresAt: expiresAtRaw.toDate(),
    );
  }
}
