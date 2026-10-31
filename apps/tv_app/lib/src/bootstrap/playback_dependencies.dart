/// Production composition for verified playback, Firebase delivery, and
/// party-scoped settings.
library;

import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:infra_firestore/infra_firestore.dart';
import 'package:infra_settings/infra_settings.dart'
    show SharedPreferencesSettings;
import 'package:infra_signed_urls/infra_signed_urls.dart';
import 'package:kernel_app/kernel_app.dart';
import 'package:path_provider/path_provider.dart';

import 'package:tv_app/src/config/backend_config.dart';
import 'package:tv_app/src/wall/guest_codes.dart';
import 'package:tv_app/src/wall/host_codes.dart';
import 'package:tv_app/src/wall/live_wall_session.dart';
import 'package:tv_app/src/wall/manifest_store.dart';
import 'package:tv_app/src/wall/wall_boot.dart';

typedef FirebaseBootstrap = Future<void> Function(BackendConfig config);

/// Fully composed app dependencies. Creating these directories and settings
/// does not start remote work; the live stream begins only after offline boot.
final class PlaybackDependencies {
  PlaybackDependencies._({
    required this.config,
    required this.channelId,
    required this.preparePlayback,
    required this.settings,
    required this.liveSession,
    required this.remoteUnavailableReason,
    required this.manifestIndexStore,
    required this.cacheStore,
    required this.guestCodeClient,
    required this.hostInviteClient,
    required this.deliveryClient,
    required this.urlSigner,
    required this.expiredUrlRefresher,
  });

  final BackendConfig config;

  /// Resolved Firestore party channel: the `TV_CHANNEL_ID` dart-define
  /// (defaulting to the CCTV channel for offline/emulator/fixture builds).
  /// Every live client and the wall boot scope through this value; the CCTV
  /// constant is never used for Firestore scope here.
  final String channelId;
  final PreparePlayback preparePlayback;
  final SettingsPort settings;
  final LiveWallSession? liveSession;

  /// Host guest-code reader; null unless the live backend is configured.
  ///
  /// Null keeps the recovery panel on its offline actions only.
  final GuestCodeClient? guestCodeClient;

  /// Host-invite minter for the HOST QR destination; null unless the live
  /// backend is configured.
  ///
  /// Null hides the HOST QR button (offline builds stay on the recovery
  /// actions only).
  final HostInviteClient? hostInviteClient;
  final String? remoteUnavailableReason;
  final ManifestIndexStore manifestIndexStore;
  final CacheStore cacheStore;

  /// Live delivery client backing URL signing; null while offline.
  final FirebaseDeliveryClient? deliveryClient;

  /// Live URL signer scoped to [channelId]; null while offline.
  final FirebaseUrlSigner? urlSigner;

  /// Live expired-URL refresher scoped to [channelId]; null while offline.
  ///
  /// Exposed so tests can assert the refresh path carries the resolved
  /// party channel (not the CCTV constant) through the real prod closure.
  final Future<Uri> Function(ClipDescriptor clip, Uri expired)?
  expiredUrlRefresher;

  static Future<PlaybackDependencies> create({
    BackendConfig? config,
    String? channelId,
    Directory? supportDirectory,
    Directory? stagingDirectory,
    FirebaseBootstrap? firebaseBootstrap,
    FirebaseFirestore? firestoreOverride,
    FirebaseFunctions? functionsOverride,
    FirebaseCallableInvoker? deliveryInvokerOverride,
    FirebaseManifestCallableInvoker? manifestInvokerOverride,
    CallableInvoker? guestCodeInvokerOverride,
    CallableInvoker? hostInviteInvokerOverride,
  }) async {
    final BackendConfig resolved = config ?? BackendConfig.fromEnvironment();
    // Explicit override wins (tests); otherwise the config's resolved
    // TV_CHANNEL_ID (defaulted to the CCTV channel for offline/emulator).
    final String liveChannel = channelId ?? resolved.channelId;
    final Directory support =
        supportDirectory ?? await getApplicationSupportDirectory();
    final Directory staging = stagingDirectory ?? await getTemporaryDirectory();
    final Directory root = Directory(_join(support.path, 'halloween-tv'));
    final Directory mediaRoot = Directory(_join(root.path, 'media-cache'));
    final Directory indexRoot = Directory(_join(root.path, 'manifest-index'));
    final Directory downloadRoot = Directory(
      _join(staging.path, 'halloween-tv-downloads'),
    );
    await Future.wait<void>(<Future<void>>[
      mediaRoot.create(recursive: true),
      indexRoot.create(recursive: true),
      downloadRoot.create(recursive: true),
    ]);

    final FileCacheStore cache = FileCacheStore(
      mediaRoot,
      indexRoot: indexRoot,
    );
    final FileManifestIndexStore manifestIndex = FileManifestIndexStore(
      indexRoot,
    );
    final SharedPreferencesSettings settings = SharedPreferencesSettings();

    FirebaseFirestore? firestore;
    FirebaseFunctions? functions;
    String? unavailable;
    final bool useInvokerSeam =
        deliveryInvokerOverride != null ||
        manifestInvokerOverride != null ||
        guestCodeInvokerOverride != null ||
        hostInviteInvokerOverride != null;
    if (useInvokerSeam) {
      // Callable-boundary seam (tests): every live client is built from the
      // injected invokers, so no Firebase app, Firestore, or Functions
      // instance is touched. Misconfiguration still fails closed below.
      if (!resolved.isLiveConfigured) {
        unavailable = resolved.error ?? 'live configuration is incomplete';
      }
    } else if (resolved.isLiveRequested && !resolved.isLiveConfigured) {
      unavailable = resolved.error ?? 'live configuration is incomplete';
    } else if (resolved.isLiveConfigured) {
      try {
        await (firebaseBootstrap ?? _initializeFirebase)(resolved);
        firestore = firestoreOverride ?? FirebaseFirestore.instance;
        if (resolved.useEmulator) {
          firestore.useFirestoreEmulator(
            resolved.firestoreEmulatorHost,
            resolved.firestoreEmulatorPort!,
          );
        }
        functions =
            functionsOverride ??
            FirebaseFunctions.instanceFor(region: resolved.functionsRegion);
        if (resolved.useEmulator) {
          functions.useFunctionsEmulator(
            resolved.functionsEmulatorHost,
            resolved.functionsEmulatorPort!,
          );
        }
      } on Object catch (error) {
        unavailable = 'Firebase could not be initialized: $error';
        firestore = null;
        functions = null;
      }
    }

    late final PreparePlayback prepare;
    LiveWallSession? live;
    GuestCodeClient? guestCodes;
    HostInviteClient? hostInvites;
    FirebaseDeliveryClient? deliveryClient;
    FirebaseUrlSigner? urlSigner;
    Future<Uri> Function(ClipDescriptor clip, Uri expired)? refresher;
    if (resolved.isLiveConfigured &&
        unavailable == null &&
        ((firestore != null && functions != null) || useInvokerSeam)) {
      final FirebaseTvIdentity identity = FirebaseTvIdentity(
        partyId: resolved.partyId,
        deviceId: resolved.deviceId,
      );
      if (useInvokerSeam) {
        // Test/emulator seam: invokers substitute the Functions SDK so the
        // real client constructors run without a Firebase app. The resolved
        // party channel scopes every client exactly like production.
        final FirebaseDeliveryClient seamDelivery = FirebaseDeliveryClient(
          identity: identity,
          callableInvoker:
              deliveryInvokerOverride ?? const _ThrowingDeliveryInvoker(),
        );
        deliveryClient = seamDelivery;
        // Manifests flow through the registered getCurrentManifest callable.
        // Direct Firestore manifest reads stay denied by
        // backend/firestore.rules; passing no firestore instance here
        // guarantees the source cannot fall back to snapshot listeners
        // even if the seam default changes.
        final FirebaseManifestSource source = FirebaseManifestSource(
          watchDocumentData: FirebaseCallableManifestTransport(
            identity: identity,
            callableInvoker:
                manifestInvokerOverride ?? const _ThrowingManifestInvoker(),
          ).watchDocumentData,
        );
        final FirebaseDeliveryClient delivery = seamDelivery;
        urlSigner = FirebaseUrlSigner(
          deliveryClient: delivery,
          channelId: liveChannel,
        );
        refresher = (ClipDescriptor clip, Uri expired) => delivery
            .refreshUrlFor(channelId: liveChannel, clip: clip);
        final HttpsMediaDownloader downloader = HttpsMediaDownloader(
          tempDirectory: downloadRoot,
          expiredUrlRefresher: refresher,
        );
        prepare = PreparePlayback(
          manifestSource: source,
          urlSigner: urlSigner,
          downloader: downloader,
          cacheStore: cache,
          manifestIndexStore: manifestIndex,
          acknowledger: delivery,
        );
        live = LiveWallSession(
          partyId: resolved.partyId,
          channelId: liveChannel,
          manifestSource: source,
          preparation: prepare,
        );
        guestCodes = GuestCodeClient(
          invoker: guestCodeInvokerOverride ?? _throwingGuestInvoker,
          partyId: resolved.partyId,
          deviceId: resolved.deviceId,
          channelId: liveChannel,
        );
        hostInvites = HostInviteClient(
          invoker: hostInviteInvokerOverride ?? _throwingHostInvoker,
          partyId: resolved.partyId,
          deviceId: resolved.deviceId,
          channelId: liveChannel,
        );
      } else {
        // Production path: the outer condition guarantees Functions
        // availability when the seam is unused; check explicitly so the
        // SDK clients keep static promotion without suppression.
        final FirebaseFunctions? sdkFunctions = functions;
        if (sdkFunctions == null) {
          throw StateError(
            'live composition requires Functions or invoker seams',
          );
        }
        final FirebaseDeliveryClient sdkDelivery = FirebaseDeliveryClient(
          identity: identity,
          functions: sdkFunctions,
        );
        deliveryClient = sdkDelivery;
        // Manifests flow through the registered getCurrentManifest callable.
        // Direct Firestore manifest reads stay denied by
        // backend/firestore.rules; passing no firestore instance here
        // guarantees the source cannot fall back to snapshot listeners
        // even if the seam default changes.
        final FirebaseManifestSource source = FirebaseManifestSource(
          watchDocumentData: FirebaseCallableManifestTransport(
            identity: identity,
            functions: sdkFunctions,
          ).watchDocumentData,
        );
        final FirebaseDeliveryClient delivery = sdkDelivery;
        urlSigner = FirebaseUrlSigner(
          deliveryClient: delivery,
          channelId: liveChannel,
        );
        refresher = (ClipDescriptor clip, Uri expired) => delivery
            .refreshUrlFor(channelId: liveChannel, clip: clip);
        final HttpsMediaDownloader downloader = HttpsMediaDownloader(
          tempDirectory: downloadRoot,
          expiredUrlRefresher: refresher,
        );
        prepare = PreparePlayback(
          manifestSource: source,
          urlSigner: urlSigner,
          downloader: downloader,
          cacheStore: cache,
          manifestIndexStore: manifestIndex,
          acknowledger: delivery,
        );
        live = LiveWallSession(
          partyId: resolved.partyId,
          channelId: liveChannel,
          manifestSource: source,
          preparation: prepare,
        );
        // Host panel reader: the TV device lists guest codes over the
        // TV-only listPartyDevices callable. Null when live is unavailable
        // keeps the recovery panel on its offline actions only.
        guestCodes = GuestCodeClient.cloudFunctions(
          functions: sdkFunctions,
          partyId: resolved.partyId,
          deviceId: resolved.deviceId,
          channelId: liveChannel,
        );
        // Host invite minter: the TV device mints scoped host invites over the
        // TV-only createHostInvite callable. Null when live is unavailable
        // hides the HOST QR destination.
        hostInvites = HostInviteClient.cloudFunctions(
          functions: sdkFunctions,
          partyId: resolved.partyId,
          deviceId: resolved.deviceId,
          channelId: liveChannel,
        );
      }
    } else {
      prepare = PreparePlayback(
        manifestSource: _UnavailableManifestSource(),
        urlSigner: _UnavailableUrlSigner(),
        downloader: _UnavailableDownloader(),
        cacheStore: cache,
        manifestIndexStore: manifestIndex,
        acknowledger: _UnavailableAcknowledger(),
      );
    }

    return PlaybackDependencies._(
      config: resolved,
      channelId: liveChannel,
      preparePlayback: prepare,
      settings: settings,
      liveSession: live,
      guestCodeClient: guestCodes,
      hostInviteClient: hostInvites,
      deliveryClient: deliveryClient,
      urlSigner: urlSigner,
      expiredUrlRefresher: refresher,
      remoteUnavailableReason: unavailable,
      manifestIndexStore: manifestIndex,
      cacheStore: cache,
    );
  }

  /// Boot object uses the configured party + channel and keeps legacy
  /// manifest prefs physically and logically separate from the durable
  /// remote index.
  WallBoot createWallBoot({
    WallManifestStore store = const PrefsManifestStore(),
  }) => WallBoot(
    store: store,
    partyId: config.partyIdOrOffline,
    channelId: channelId,
    tvDeviceId: config.deviceId,
    guestCodeClient: guestCodeClient,
    hostInviteClient: hostInviteClient,
    preparePlayback: preparePlayback,
    liveSession: liveSession,
    settings: settings,
    remoteUnavailableReason: remoteUnavailableReason,
    manifestIndexStore: manifestIndexStore,
    cacheStore: cacheStore,
  );

  static Future<void> _initializeFirebase(BackendConfig config) async {
    // FirebaseInitProvider may have already created [DEFAULT] from
    // google-services.json (e.g. redacted local options). Tolerate that and
    // use the pre-initialized default: callable transports do not consume
    // the API key, so a key-mismatched default still reaches the backend.
    if (Firebase.apps.isEmpty) {
      try {
        await Firebase.initializeApp(options: config.firebaseOptions!);
      } on FirebaseException catch (error) {
        if (error.code != 'duplicate-app') rethrow;
      }
    }
  }
}

final class _UnavailableManifestSource
    implements ManifestSource<PlaybackManifest> {
  @override
  Stream<PlaybackManifest> watchCurrent({
    required String partyId,
    required String channelId,
  }) =>
      Stream<PlaybackManifest>.error(StateError('remote playback is disabled'));
}

final class _UnavailableUrlSigner implements UrlSigner {
  @override
  Future<Uri> signFor(
    ClipDescriptor clip, {
    Duration expiry = const Duration(hours: 1),
  }) => Future<Uri>.error(StateError('remote playback is disabled'));
}

final class _UnavailableDownloader implements MediaDownloader {
  @override
  Future<DownloadedMedia> downloadAndVerify(ClipDescriptor clip, Uri source) =>
      Future<DownloadedMedia>.error(StateError('remote playback is disabled'));
}

final class _UnavailableAcknowledger implements DeliveryAcknowledger {
  @override
  Future<void> acknowledge({
    required String partyId,
    required String channelId,
    required int manifestVersion,
    required Map<String, String> verifiedClipHashes,
  }) => Future<void>.error(StateError('remote playback is disabled'));
}

/// Seams must be provided together in tests; a missing leg fails loudly
/// instead of touching the Functions SDK.
final class _ThrowingDeliveryInvoker implements FirebaseCallableInvoker {
  const _ThrowingDeliveryInvoker();

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) =>
      Future<Object?>.error(
        StateError('delivery invoker override is required for this test path'),
      );
}

final class _ThrowingManifestInvoker
    implements FirebaseManifestCallableInvoker {
  const _ThrowingManifestInvoker();

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) =>
      Future<Object?>.error(
        StateError('manifest invoker override is required for this test path'),
      );
}

Future<Map<String, Object?>> _throwingGuestInvoker(
  String name,
  Map<String, Object?> payload,
) => Future<Map<String, Object?>>.error(
  StateError('guest-code invoker override is required for this test path'),
);

Future<Map<String, Object?>> _throwingHostInvoker(
  String name,
  Map<String, Object?> payload,
) => Future<Map<String, Object?>>.error(
  StateError('host-invite invoker override is required for this test path'),
);

String _join(String parent, String child) =>
    parent.endsWith(Platform.pathSeparator)
    ? '$parent$child'
    : '$parent${Platform.pathSeparator}$child';
