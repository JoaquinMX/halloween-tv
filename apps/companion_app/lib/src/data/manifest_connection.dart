/// Read-only manifest connection for the companion app.
///
/// Composes the real [FirebaseCallableManifestTransport] and
/// [FirebaseManifestSource] behind `channel_api`
/// `ManifestSource<PlaybackManifest>`. The transport's
/// [FirebaseCallableManifestTransport.watchDocumentData] is always supplied
/// explicitly, so direct Firestore snapshot reads can never be selected.
/// Documents flow through the existing `cameraClips` mapper
/// ([manifestFromFirestore]) and [validateCctvManifest] is applied before
/// any manifest reaches presentation.
///
/// Polling surfaces failures promptly: the successful poll interval is
/// ~30s, [FirebaseCallableManifestTransport.maxConsecutiveFailures] is 0,
/// and [FirebaseManifestSource.maxTransportResubscriptions] is 0, so the
/// first failure errors the stream and retry stays explicit with the
/// caller (see [ManifestFailure.retryable]).
library;

import 'package:channel_api/channel_api.dart' show ManifestSource;
import 'package:core_foundation/core_foundation.dart' show Err, Ok;
import 'package:core_playlist/core_playlist.dart'
    show PlaybackManifest, validateCctvManifest;
import 'package:infra_firestore/infra_firestore.dart'
    show
        FirebaseCallableManifestTransport,
        FirebaseManifestCallableInvoker,
        FirebaseManifestSource,
        FirebaseTvIdentity,
        ManifestSchemaException;

/// Successful poll interval for the current-manifest callable.
const Duration kManifestPollInterval = Duration(seconds: 30);

/// Read-only `ManifestSource<PlaybackManifest>` over `getCurrentManifest`.
final class ManifestConnection implements ManifestSource<PlaybackManifest> {
  ManifestConnection({
    required FirebaseTvIdentity identity,
    required FirebaseManifestCallableInvoker invoker,
    this.pollInterval = kManifestPollInterval,
  }) : _identity = identity,
       _invoker = invoker;

  final FirebaseTvIdentity _identity;
  final FirebaseManifestCallableInvoker _invoker;
  final Duration pollInterval;

  @override
  Stream<PlaybackManifest> watchCurrent({
    required String partyId,
    required String channelId,
  }) {
    final FirebaseCallableManifestTransport transport =
        FirebaseCallableManifestTransport(
          identity: _identity,
          callableInvoker: _invoker,
          // Failures surface promptly; retry is explicit with the caller.
          pollInterval: pollInterval,
          maxConsecutiveFailures: 0,
        );
    final FirebaseManifestSource source = FirebaseManifestSource(
      // Explicitly supplied: direct Firestore reads cannot be selected.
      watchDocumentData: transport.watchDocumentData,
      maxTransportResubscriptions: 0,
    );
    return source
        .watchCurrent(partyId: partyId, channelId: channelId)
        .map(_validated);
  }

  static PlaybackManifest _validated(PlaybackManifest manifest) {
    switch (validateCctvManifest(manifest)) {
      case Ok():
        return manifest;
      case Err(:final String message):
        throw ManifestSchemaException(message);
    }
  }
}
