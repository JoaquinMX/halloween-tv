/// Composition root wiring config -> connection -> `ManifestSource`.
///
/// [CompanionDependencies.create] resolves a [BackendConfig] (defaulting to
/// unconfigured/offline boot), initializes Firebase only when a cloud
/// target was explicitly selected and validated, and exposes a
/// `channel_api` `ManifestSource<PlaybackManifest>` backed by the real
/// callable transport. Invalid config or init failure resolves to a
/// recoverable [remoteUnavailableReason] with an erroring manifest source;
/// a cloud target is never silently selected.
///
/// Party/device identity arrives from the join flow (a later partition) as
/// a [FirebaseTvIdentity]; without one the connection cannot scope the
/// callable, so the source stays unavailable.
library;

import 'package:channel_api/channel_api.dart' show ManifestSource;
import 'package:cloud_functions/cloud_functions.dart';
import 'package:core_playlist/core_playlist.dart' show PlaybackManifest;
import 'package:firebase_core/firebase_core.dart';
import 'package:infra_firestore/infra_firestore.dart'
    show
        FirebaseManifestCallableInvoker,
        FirebaseTvIdentity,
        ManifestTransportException;

import 'package:companion_app/src/config/backend_config.dart';
import 'package:companion_app/src/data/callable_manifest_invoker.dart';
import 'package:companion_app/src/data/manifest_connection.dart';
import 'package:companion_app/src/data/manifest_failure.dart';

/// Injectable Firebase bootstrap for tests and emulator wiring.
typedef FirebaseBootstrap = Future<void> Function(BackendConfig config);

/// Fully composed companion dependencies.
final class CompanionDependencies {
  CompanionDependencies._({
    required this.config,
    required this.manifestSource,
    required this.identity,
    required this.remoteUnavailableReason,
  });

  final BackendConfig config;
  final ManifestSource<PlaybackManifest> manifestSource;
  final FirebaseTvIdentity? identity;
  final String? remoteUnavailableReason;

  /// True when the manifest source is backed by the live callable.
  bool get isLive => remoteUnavailableReason == null;

  static Future<CompanionDependencies> create({
    BackendConfig? config,
    FirebaseTvIdentity? identity,
    FirebaseBootstrap? firebaseBootstrap,
    FirebaseFunctions? functionsOverride,
    FirebaseManifestCallableInvoker? invokerOverride,
  }) async {
    final BackendConfig resolved = config ?? BackendConfig.unconfigured();
    if (!resolved.isLiveConfigured) {
      return CompanionDependencies._(
        config: resolved,
        manifestSource: _UnavailableManifestSource(
          ManifestFailure.configuration(
            resolved.error ?? 'backend is not configured',
          ),
        ),
        identity: identity,
        remoteUnavailableReason: resolved.error ?? 'backend is not configured',
      );
    }
    if (identity == null) {
      const String reason = 'guest identity is not provisioned';
      return CompanionDependencies._(
        config: resolved,
        manifestSource: _UnavailableManifestSource(
          ManifestFailure.configuration(reason),
        ),
        identity: null,
        remoteUnavailableReason: reason,
      );
    }
    try {
      await (firebaseBootstrap ?? _initializeFirebase)(resolved);
      final FirebaseManifestCallableInvoker invoker;
      if (invokerOverride != null) {
        invoker = invokerOverride;
      } else {
        final FirebaseFunctions functions =
            functionsOverride ??
            FirebaseFunctions.instanceFor(region: resolved.functionsRegion);
        if (resolved.useEmulator) {
          functions.useFunctionsEmulator(
            resolved.functionsEmulatorHost,
            resolved.functionsEmulatorPort!,
          );
        }
        invoker = CallableManifestInvoker(functions: functions);
      }
      return CompanionDependencies._(
        config: resolved,
        manifestSource: ManifestConnection(
          identity: identity,
          invoker: invoker,
        ),
        identity: identity,
        remoteUnavailableReason: null,
      );
    } on Object catch (error) {
      final ManifestFailure failure = ManifestFailure.classify(error);
      return CompanionDependencies._(
        config: resolved,
        manifestSource: _UnavailableManifestSource(failure),
        identity: identity,
        remoteUnavailableReason:
            'Firebase could not be initialized: ${failure.message}',
      );
    }
  }

  static Future<void> _initializeFirebase(BackendConfig config) async {
    if (Firebase.apps.isEmpty) {
      await Firebase.initializeApp(options: config.firebaseOptions!);
    }
  }
}

final class _UnavailableManifestSource
    implements ManifestSource<PlaybackManifest> {
  _UnavailableManifestSource(this.failure);

  final ManifestFailure failure;

  @override
  Stream<PlaybackManifest> watchCurrent({
    required String partyId,
    required String channelId,
  }) => Stream<PlaybackManifest>.error(
    ManifestTransportException('remote manifest is unavailable', failure),
  );
}
