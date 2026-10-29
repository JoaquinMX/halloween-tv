/// Durable pointer to a complete, locally verified manifest version.
library;

import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';

/// The last complete manifest plus its SHA-256 to opaque local-reference map.
///
/// `clipHashToLocalRef` is written as one unit with [manifest], so offline
/// startup can never observe a partially downloaded version.
final class CommittedManifestIndex {
  /// The manifest whose complete clip set was committed.
  final PlaybackManifest manifest;

  /// Maps normalized clip SHA-256 digests to opaque local resource ids.
  final Map<String, String> clipHashToLocalRef;

  /// Creates an index that covers exactly the manifest's clips.
  factory CommittedManifestIndex({
    required PlaybackManifest manifest,
    required Map<String, String> clipHashToLocalRef,
  }) {
    final validation = validateCctvManifest(manifest);
    if (validation.isErr) {
      final Err<PlaybackManifest> error = validation as Err<PlaybackManifest>;
      throw ArgumentError(
        'manifest index requires a valid CCTV manifest: ${error.message}',
      );
    }
    final Map<String, String> normalized = <String, String>{
      for (final MapEntry<String, String> entry in clipHashToLocalRef.entries)
        entry.key.toLowerCase(): entry.value,
    };
    if (normalized.length != clipHashToLocalRef.length) {
      throw ArgumentError('clip hash keys collide after normalization');
    }
    if (manifest.partyId.trim().isEmpty || manifest.channelId.trim().isEmpty) {
      throw ArgumentError('manifest partyId and channelId must be non-empty');
    }
    if (manifest.version <= 0) {
      throw ArgumentError.value(manifest.version, 'manifest.version');
    }
    final Set<String> expected = <String>{
      for (final ClipDescriptor clip in manifest.clips)
        clip.sha256.toLowerCase(),
    };
    if (expected.length != normalized.length) {
      throw ArgumentError(
        'index must contain one local reference for each distinct clip hash',
      );
    }
    for (final String hash in expected) {
      final String? localRef = normalized[hash];
      if (localRef == null || localRef.trim().isEmpty) {
        throw ArgumentError('missing local reference for clip hash $hash');
      }
    }
    return CommittedManifestIndex._(
      manifest,
      Map<String, String>.unmodifiable(normalized),
    );
  }

  CommittedManifestIndex._(this.manifest, this.clipHashToLocalRef);

  /// Monotonically committed version.
  int get committedVersion => manifest.version;

  /// Resolves the local ref for [clip], or null when it is not indexed.
  String? localRefFor(ClipDescriptor clip) =>
      clipHashToLocalRef[clip.sha256.toLowerCase()];
}

/// Durable storage contract for last-known-good manifest indexes.
abstract interface class ManifestIndexStore {
  /// Reads the committed index for a party/channel, or null on a cold start.
  Future<CommittedManifestIndex?> readCommitted({
    required String partyId,
    required String channelId,
  });

  /// Atomically replaces the index with a fully verified [index].
  ///
  /// Implementations must make either the previous index or [index] visible
  /// after interruption; callers only invoke this after all clips are durable.
  Future<void> writeAtomically(CommittedManifestIndex index);
}
