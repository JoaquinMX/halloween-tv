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
/// Party/device identity arrives with the join flow as validated
/// [GuestJoinData]: a live backend without a join-time identity yet is
/// "unscoped" (Firebase initialized, invoker built, [isLive] true) and each
/// join scopes its own source through [manifestSourceForJoin], which builds
/// a [FirebaseTvIdentity] from the guest-typed IDs so they scope the actual
/// callable payload. A fixed [FirebaseTvIdentity] may still be supplied to
/// [create] for single-identity compositions.
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
import 'package:companion_app/src/data/party_join_client.dart';
import 'package:companion_app/src/data/guest_media_client.dart';
import 'package:companion_app/src/join/guest_join_data.dart';

/// Injectable Firebase bootstrap for tests and emulator wiring.
typedef FirebaseBootstrap = Future<void> Function(BackendConfig config);

/// Fully composed companion dependencies.
final class CompanionDependencies {
  CompanionDependencies._({
    required this.config,
    required this.manifestSource,
    required this.identity,
    required this.remoteUnavailableReason,
    required FirebaseManifestCallableInvoker? invoker,
    required this.partyJoinClient,
    required this.guestMediaClient,
  }) : _invoker = invoker;

  final BackendConfig config;
  final ManifestSource<PlaybackManifest> manifestSource;
  final FirebaseTvIdentity? identity;
  final String? remoteUnavailableReason;
  final FirebaseManifestCallableInvoker? _invoker;
  final PartyJoinClient? partyJoinClient;
  final GuestMediaClient? guestMediaClient;

  /// True when the manifest source is backed by the live callable.
  bool get isLive => remoteUnavailableReason == null;

  /// Builds the per-join scoped source for validated [join] identifiers.
  ///
  /// The [FirebaseTvIdentity] is derived from the guest-typed party/device
  /// IDs so they scope the actual callable payload; the [channelId] scopes
  /// the requested document. Identity construction is deferred to the
  /// first [ManifestSource.watchCurrent] call so an identifier the guest
  /// parser accepts but the backend identity shape rejects surfaces as a
  /// session `invalidData` error (via [ManifestFailure.classify]) instead
  /// of throwing out of the join wiring. When no live invoker is available
  /// (offline/unconfigured), returns the base [manifestSource] so the
  /// existing recoverable reason still surfaces.
  ManifestSource<PlaybackManifest> manifestSourceForJoin(GuestJoinData join) {
    final FirebaseManifestCallableInvoker? invoker = _invoker;
    if (invoker == null) {
      return manifestSource;
    }
    return _JoinScopedSource(join: join, invoker: invoker);
  }

  static Future<CompanionDependencies> create({
    BackendConfig? config,
    FirebaseTvIdentity? identity,
    FirebaseBootstrap? firebaseBootstrap,
    FirebaseFunctions? functionsOverride,
    FirebaseManifestCallableInvoker? invokerOverride,
    PartyJoinCallableInvoker? partyJoinInvokerOverride,
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
        invoker: null,
        partyJoinClient: null,
        guestMediaClient: null,
      );
    }
    if (identity == null) {
      // Live backend selected but no fixed identity: this is the normal
      // pre-join state. Firebase is still initialized now (so init failures
      // surface pre-join as recoverable state) and the invoker is built;
      // each join scopes its own source through [manifestSourceForJoin].
      try {
        await (firebaseBootstrap ?? _initializeFirebase)(resolved);
        FirebaseFunctions? functions;
        FirebaseFunctions resolveFunctions() =>
            functions ??= _configuredFunctions(resolved, functionsOverride);
        final FirebaseManifestCallableInvoker invoker;
        if (invokerOverride != null) {
          invoker = invokerOverride;
        } else {
          invoker = CallableManifestInvoker(functions: resolveFunctions());
        }
        return CompanionDependencies._(
          config: resolved,
          manifestSource: _UnscopedManifestSource(),
          identity: null,
          remoteUnavailableReason: null,
          invoker: invoker,
          guestMediaClient: GuestMediaClient(
            invoker: CallableGuestMediaInvoker(resolveFunctions),
            transport: HttpGuestMediaTransport(),
          ),
          partyJoinClient: PartyJoinClient(
            invoker:
                partyJoinInvokerOverride ??
                CallablePartyJoinInvoker(functions: resolveFunctions()),
          ),
        );
      } on Object catch (error) {
        final ManifestFailure failure = ManifestFailure.classify(error);
        return CompanionDependencies._(
          config: resolved,
          manifestSource: _UnavailableManifestSource(failure),
          identity: null,
          remoteUnavailableReason:
              'Firebase could not be initialized: ${failure.message}',
          invoker: null,
          partyJoinClient: null,
          guestMediaClient: null,
        );
      }
    }
    try {
      await (firebaseBootstrap ?? _initializeFirebase)(resolved);
      FirebaseFunctions? functions;
      FirebaseFunctions resolveFunctions() =>
          functions ??= _configuredFunctions(resolved, functionsOverride);
      final FirebaseManifestCallableInvoker invoker;
      if (invokerOverride != null) {
        invoker = invokerOverride;
      } else {
        invoker = CallableManifestInvoker(functions: resolveFunctions());
      }
      return CompanionDependencies._(
        config: resolved,
        manifestSource: ManifestConnection(
          identity: identity,
          invoker: invoker,
        ),
        identity: identity,
        remoteUnavailableReason: null,
        invoker: invoker,
        guestMediaClient: GuestMediaClient(
          invoker: CallableGuestMediaInvoker(resolveFunctions),
          transport: HttpGuestMediaTransport(),
        ),
        partyJoinClient: PartyJoinClient(
          invoker:
              partyJoinInvokerOverride ??
              CallablePartyJoinInvoker(functions: resolveFunctions()),
        ),
      );
    } on Object catch (error) {
      final ManifestFailure failure = ManifestFailure.classify(error);
      return CompanionDependencies._(
        config: resolved,
        manifestSource: _UnavailableManifestSource(failure),
        identity: identity,
        remoteUnavailableReason:
            'Firebase could not be initialized: ${failure.message}',
        invoker: null,
        partyJoinClient: null,
        guestMediaClient: null,
      );
    }
  }

  static Future<void> _initializeFirebase(BackendConfig config) async {
    if (Firebase.apps.isEmpty) {
      await Firebase.initializeApp(options: config.firebaseOptions!);
    }
  }

  static FirebaseFunctions _configuredFunctions(
    BackendConfig config,
    FirebaseFunctions? override,
  ) {
    final FirebaseFunctions functions =
        override ??
        FirebaseFunctions.instanceFor(region: config.functionsRegion);
    if (config.useEmulator) {
      functions.useFunctionsEmulator(
        config.functionsEmulatorHost,
        config.functionsEmulatorPort!,
      );
    }
    return functions;
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

/// Placeholder source for a live-but-unscoped composition (pre-join).
///
/// The app never reads through this: every join scopes its own source via
/// [CompanionDependencies.manifestSourceForJoin]. Surfacing here means a
/// programming error (reading before a join bound an identity).
final class _UnscopedManifestSource
    implements ManifestSource<PlaybackManifest> {
  @override
  Stream<PlaybackManifest> watchCurrent({
    required String partyId,
    required String channelId,
  }) => Stream<PlaybackManifest>.error(
    StateError('join a party before reading the manifest'),
  );
}

/// Per-join scoped source: derives the [FirebaseTvIdentity] from validated
/// [GuestJoinData] so the guest-typed IDs scope the actual callable
/// payload, then delegates to a real [ManifestConnection].
///
/// Identity construction is deferred to the first `watchCurrent` call so an
/// identifier the guest parser accepts but the backend identity shape
/// rejects surfaces as a session `invalidData` error (the session's
/// subscribe path funnels synchronous `watchCurrent` throws through
/// [ManifestFailure.classify]) instead of throwing out of the join wiring.
final class _JoinScopedSource implements ManifestSource<PlaybackManifest> {
  _JoinScopedSource({required GuestJoinData join, required this.invoker})
    : _join = join;

  final GuestJoinData _join;
  final FirebaseManifestCallableInvoker invoker;

  @override
  Stream<PlaybackManifest> watchCurrent({
    required String partyId,
    required String channelId,
  }) {
    final ManifestConnection connection = ManifestConnection(
      identity: FirebaseTvIdentity(
        partyId: _join.partyId.value,
        deviceId: _join.deviceId.value,
      ),
      invoker: invoker,
    );
    return connection.watchCurrent(partyId: partyId, channelId: channelId);
  }
}
