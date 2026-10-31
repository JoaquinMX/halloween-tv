/// Production composition for verified playback, Firebase delivery, and
/// party-scoped settings.
library;

import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:channel_cctv/channel_cctv.dart';
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
    required this.preparePlayback,
    required this.settings,
    required this.liveSession,
    required this.remoteUnavailableReason,
    required this.manifestIndexStore,
    required this.cacheStore,
    required this.guestCodeClient,
    required this.hostInviteClient,
  });

  final BackendConfig config;
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

  static Future<PlaybackDependencies> create({
    BackendConfig? config,
    Directory? supportDirectory,
    Directory? stagingDirectory,
    FirebaseBootstrap? firebaseBootstrap,
    FirebaseFirestore? firestoreOverride,
    FirebaseFunctions? functionsOverride,
  }) async {
    final BackendConfig resolved = config ?? BackendConfig.fromEnvironment();
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
    if (resolved.isLiveRequested && !resolved.isLiveConfigured) {
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
    if (resolved.isLiveConfigured &&
        unavailable == null &&
        firestore != null &&
        functions != null) {
      final FirebaseTvIdentity identity = FirebaseTvIdentity(
        partyId: resolved.partyId,
        deviceId: resolved.deviceId,
      );
      final FirebaseDeliveryClient delivery = FirebaseDeliveryClient(
        identity: identity,
        functions: functions,
      );
      // Manifests flow through the registered getCurrentManifest callable.
      // Direct Firestore manifest reads stay denied by backend/firestore.rules;
      // passing no firestore instance here guarantees the source cannot fall
      // back to snapshot listeners even if the seam default changes.
      final FirebaseManifestSource source = FirebaseManifestSource(
        watchDocumentData: FirebaseCallableManifestTransport(
          identity: identity,
          functions: functions,
        ).watchDocumentData,
      );
      final FirebaseUrlSigner signer = FirebaseUrlSigner(
        deliveryClient: delivery,
        channelId: hauntedSurveillanceChannelId,
      );
      final HttpsMediaDownloader downloader = HttpsMediaDownloader(
        tempDirectory: downloadRoot,
        expiredUrlRefresher: (ClipDescriptor clip, Uri expired) => delivery
            .refreshUrlFor(channelId: hauntedSurveillanceChannelId, clip: clip),
      );
      prepare = PreparePlayback(
        manifestSource: source,
        urlSigner: signer,
        downloader: downloader,
        cacheStore: cache,
        manifestIndexStore: manifestIndex,
        acknowledger: delivery,
      );
      live = LiveWallSession(
        partyId: resolved.partyId,
        channelId: hauntedSurveillanceChannelId,
        manifestSource: source,
        preparation: prepare,
      );
      // Host panel reader: the TV device lists guest codes over the
      // TV-only listPartyDevices callable. Null when live is unavailable
      // keeps the recovery panel on its offline actions only.
      guestCodes = GuestCodeClient.cloudFunctions(
        functions: functions,
        partyId: resolved.partyId,
        deviceId: resolved.deviceId,
        channelId: hauntedSurveillanceChannelId,
      );
      // Host invite minter: the TV device mints scoped host invites over the
      // TV-only createHostInvite callable. Null when live is unavailable
      // hides the HOST QR destination.
      hostInvites = HostInviteClient.cloudFunctions(
        functions: functions,
        partyId: resolved.partyId,
        deviceId: resolved.deviceId,
        channelId: hauntedSurveillanceChannelId,
      );
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
      preparePlayback: prepare,
      settings: settings,
      liveSession: live,
      guestCodeClient: guestCodes,
      hostInviteClient: hostInvites,
      remoteUnavailableReason: unavailable,
      manifestIndexStore: manifestIndex,
      cacheStore: cache,
    );
  }

  /// Boot object uses the configured party and keeps legacy manifest prefs
  /// physically and logically separate from the durable remote index.
  WallBoot createWallBoot({
    WallManifestStore store = const PrefsManifestStore(),
  }) => WallBoot(
    store: store,
    partyId: config.partyIdOrOffline,
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
    if (Firebase.apps.isEmpty) {
      await Firebase.initializeApp(options: config.firebaseOptions!);
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

String _join(String parent, String child) =>
    parent.endsWith(Platform.pathSeparator)
    ? '$parent$child'
    : '$parent${Platform.pathSeparator}$child';
