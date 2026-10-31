/// Boot sequence: kernel registry -> channels -> manifest -> wall.
///
/// Offline-first: zero network on boot. The fallback manifest comes from the
/// bundled `assets/fixture_manifest.json` (emitted by
/// `tool/gen_fixtures.sh` from the REAL asset bytes via `parseManifest`),
/// loaded with `rootBundle`. `package:testing_toolkit`'s `manifestFixture`
/// (fabricated digests) is test-only and must never be imported here.
///
/// Phase-2 note (full CacheStore adapter, not yet wired): once the
/// on-disk verified media cache lands, boot will resolve each clip through
/// `CacheStore.findVerified` (re-hash on hit, miss on digest mismatch) and
/// `commit` verified downloads before handing the manifest to the wall.
/// Until then, boot verifies the bundled offline bytes directly with
/// `sha256Hex` and fails closed to unavailable on any sha256/size mismatch.
library;

import 'dart:convert';

import 'package:channel_cctv/channel_cctv.dart';
import 'package:channel_retro_tv/channel_retro_tv.dart';
import 'package:core_cache/core_cache.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter/services.dart';
import 'package:kernel_app/kernel_app.dart';
import 'package:tv_app/src/media/feed_assets.dart';
import 'package:tv_app/src/wall/guest_codes.dart';
import 'package:tv_app/src/wall/host_codes.dart';
import 'package:tv_app/src/wall/live_wall_session.dart';
import 'package:tv_app/src/wall/manifest_store.dart';

/// Bundled fixture manifest asset (emitted from real asset bytes).
const String kBundledFixtureManifestKey = 'assets/fixture_manifest.json';

/// Outcome of booting the wall: either a resolved channel + manifest, or the
/// reason no wall is available (drives the app-level status screen).
final class WallBootResult {
  /// Everything needed to render the wall is present.
  const WallBootResult.ready({
    required ChannelRegistry this.registry,
    required ChannelPlugin this.plugin,
    required PlaybackManifest this.manifest,
    required this.usedCachedManifest,
    this.mediaByClipId = const <String, CachedMedia>{},
    this.liveSession,
    this.settings,
    this.initialEffectsDisabled = false,
    this.initialCameraCount = kDefaultCctvClipCount,
    this.hostInviteClient,
    this.remoteUnavailableReason,
  }) : unavailableReason = null;

  /// No wall can be shown; [unavailableReason] is user-facing.
  const WallBootResult.unavailable(this.unavailableReason)
    : registry = null,
      plugin = null,
      manifest = null,
      usedCachedManifest = false,
      mediaByClipId = const <String, CachedMedia>{},
      liveSession = null,
      settings = null,
      initialEffectsDisabled = false,
      initialCameraCount = kDefaultCctvClipCount,
      hostInviteClient = null,
      remoteUnavailableReason = null;

  /// Channel registry built during boot.
  final ChannelRegistry? registry;

  /// Resolved active channel plugin.
  final ChannelPlugin? plugin;

  /// Validated manifest driving the wall.
  final PlaybackManifest? manifest;

  /// True when the wall came from the last cached manifest (not the bundle).
  final bool usedCachedManifest;

  /// Verified durable media keyed by clip id; empty means bundled fallback.
  final Map<String, CachedMedia> mediaByClipId;

  /// Remote session started only after this wall has rendered.
  final LiveWallSession? liveSession;

  /// Party-scoped TV settings.
  final SettingsPort? settings;

  /// Restored effect setting for this party.
  final bool initialEffectsDisabled;

  /// Restored camera display cap for this party (1, 2, or 4).
  ///
  /// Party-scoped `SettingsPort` string key
  /// ([CctvWallSettingsKeys.cameraCount], encoding `'1'`/`'2'`/`'4'`);
  /// absent, invalid, or unreadable values default to 4. Passed through
  /// [WallGate] as the wall's initial count before wall construction.
  final int initialCameraCount;

  /// Host-invite minter for the HOST QR destination; null keeps the
  /// recovery panel on its guest/offline actions only.
  final HostInviteClient? hostInviteClient;

  /// Why configured live playback was disabled, if applicable.
  final String? remoteUnavailableReason;

  /// Why the wall is unavailable, when it is.
  final String? unavailableReason;

  /// Whether a wall can be rendered.
  bool get isReady => plugin != null && manifest != null;
}

/// Builds the channel registry; injectable so tests can simulate a registry
/// without the haunted-surveillance channel.
typedef WallRegistryFactory = ChannelRegistry Function();

/// Builds the offline fallback manifest (legacy sync override, tests only).
typedef WallManifestFixture =
    PlaybackManifest Function({
      required String partyId,
      required String channelId,
    });

/// Loads the bundled fixture manifest JSON text (injected in tests so a
/// missing bundle file does not need the real asset pipeline).
typedef WallBundleLoader = Future<String> Function(String assetKey);

/// Loads raw bytes for a bundled asset path (injected in tests).
typedef WallAssetBytesLoader = Future<List<int>> Function(String assetPath);

/// Async fallback-manifest loader (bundled `fixture_manifest.json`).
typedef WallFixtureLoader =
    Future<PlaybackManifest> Function({
      required String partyId,
      required String channelId,
    });

/// Default registry: haunted surveillance (active) + retro horror (stub that
/// is registered so the kernel can list it, but never resolved/activated).
ChannelRegistry defaultWallRegistry() {
  final ChannelRegistry registry = ChannelRegistry();
  registry.register(const HauntedSurveillancePlugin());
  registry.register(const RetroHorrorPlugin());
  return registry;
}

/// Default bundle text loader: the real Flutter asset pipeline.
Future<String> defaultBundleLoader(String assetKey) =>
    rootBundle.loadString(assetKey);

/// Default asset-bytes loader: the real Flutter asset pipeline.
Future<List<int>> defaultAssetBytesLoader(String assetPath) async {
  final ByteData data = await rootBundle.load(assetPath);
  return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
}

/// Parses a bundled fixture-manifest JSON document.
///
/// Accepts two shapes:
///  * full manifest JSON (as produced by `manifest.toJson()` / consumed by
///    `parseManifest`), and
///  * the `gen_fixtures.sh` offline shape
///    `{clips: [{cameraId, sha256, sizeBytes, durationMs, asset}]}`.
///    In the latter case [partyId]/[channelId] are supplied by the caller,
///    clip `id` defaults to the camera id, `storageObjectId` to `asset`,
///    and `mimeType` to `video/mp4`.
PlaybackManifest parseFixtureManifestJson(
  Map<String, Object?> json, {
  required String partyId,
  required String channelId,
}) {
  final Object? rawClips = json['clips'];
  final bool looksLikeFixtureShape =
      rawClips is List &&
      rawClips.isNotEmpty &&
      rawClips.first is Map &&
      (rawClips.first as Map).containsKey('cameraId') &&
      !(rawClips.first as Map).containsKey('id');
  if (!looksLikeFixtureShape) {
    return parseManifest(json);
  }
  final List<ClipDescriptor> clips = <ClipDescriptor>[
    for (final Object? entry in rawClips as List<Object?>)
      _clipFromFixtureEntry(
        Map<String, Object?>.from(entry! as Map<Object?, Object?>),
      ),
  ];
  final int version = (json['version'] as num?)?.toInt() ?? 1;
  final Object? published = json['publishedAt'];
  final DateTime publishedAt = published is String
      ? DateTime.parse(published)
      : DateTime.utc(2026, 10, 31, 20);
  return PlaybackManifest(
    partyId: partyId,
    channelId: channelId,
    version: version,
    clips: clips,
    publishedAt: publishedAt,
  );
}

ClipDescriptor _clipFromFixtureEntry(Map<String, Object?> entry) {
  final String cameraId = entry['cameraId']! as String;
  final String asset = entry['asset']! as String;
  // Clip ids follow the wall convention `clip-01` for `CAM-01` (the HUD
  // renders `CAM-01 · clip-01`); fall back to the camera id when the
  // suffix is not a plain number.
  final String suffix = cameraId.startsWith('CAM-')
      ? cameraId.substring(4)
      : cameraId;
  final String id = RegExp(r'^\d+$').hasMatch(suffix)
      ? 'clip-$suffix'
      : cameraId;
  return ClipDescriptor(
    id: id,
    cameraId: cameraId,
    storageObjectId: asset,
    sha256: entry['sha256']! as String,
    sizeBytes: (entry['sizeBytes']! as num).toInt(),
    duration: Duration(milliseconds: (entry['durationMs']! as num).toInt()),
    mimeType: (entry['mimeType'] as String?) ?? 'video/mp4',
  );
}

/// Loads the bundled offline fallback manifest (zero network).
Future<PlaybackManifest> loadBundledFixtureManifest({
  required String partyId,
  required String channelId,
  WallBundleLoader loader = defaultBundleLoader,
  String assetKey = kBundledFixtureManifestKey,
}) async {
  final String raw = await loader(assetKey);
  final Object? decoded = jsonDecode(raw);
  if (decoded is! Map<Object?, Object?>) {
    throw const FormatException('fixture manifest must be a JSON object');
  }
  return parseFixtureManifestJson(
    Map<String, Object?>.from(decoded),
    partyId: partyId,
    channelId: channelId,
  );
}

/// Resolves the bundled asset path for [clip].
///
/// Prefers an explicit `assets/…` storage reference (the shape emitted by
/// `gen_fixtures.sh`); otherwise falls back to the camera catalog.
String? assetPathForClip(ClipDescriptor clip) {
  if (clip.storageObjectId.startsWith('assets/')) {
    return clip.storageObjectId;
  }
  return kCameraAssetPaths[clip.cameraId];
}

/// Boots the microkernel and restores the wall manifest.
final class WallBoot {
  /// Creates the boot sequence.
  const WallBoot({
    this.store = const PrefsManifestStore(),
    this.partyId = 'local-party',
    this.channelId = hauntedSurveillanceChannelId,
    this.tvDeviceId = '',
    this.guestCodeClient,
    this.hostInviteClient,
    this.registryFactory = defaultWallRegistry,
    this.fixture,
    this.fixtureLoader,
    this.assetBytesLoader,
    this.bundleLoader = defaultBundleLoader,
    this.preparePlayback,
    this.liveSession,
    this.settings,
    this.manifestIndexStore,
    this.cacheStore,
    this.remoteUnavailableReason,
  });

  /// Last-known-good manifest persistence.
  final WallManifestStore store;

  /// Party the wall belongs to.
  final String partyId;

  /// Resolved Firestore party channel (provisioned `TV_CHANNEL_ID` in live
  /// builds; the CCTV channel by default so bundled-fixture behavior is
  /// unchanged). Scopes the fixture manifest, the durable offline boot, and
  /// every cached-vs-live channel comparison. Channel-plugin resolution
  /// below stays on the CCTV descriptor id, which is camera-tile labeling,
  /// not Firestore scope.
  final String channelId;

  /// TV's own device code, shown on the host guest-code page.
  final String tvDeviceId;

  /// Host guest-code reader; null keeps the recovery panel offline-only.
  final GuestCodeClient? guestCodeClient;

  /// Host-invite minter; null keeps the recovery panel without HOST QR.
  final HostInviteClient? hostInviteClient;

  /// Registry factory (channel registration).
  final WallRegistryFactory registryFactory;

  /// Legacy sync fallback override (tests only; takes precedence when set).
  final WallManifestFixture? fixture;

  /// Async bundled-fixture loader (defaults to `fixture_manifest.json`).
  final WallFixtureLoader? fixtureLoader;

  /// Bundled asset-bytes loader (defaults to `rootBundle`).
  final WallAssetBytesLoader? assetBytesLoader;

  /// Bundle text loader for the fixture manifest (injected in tests).
  final WallBundleLoader bundleLoader;

  /// Offline-first remote playback coordinator (remote work is not started).
  final PreparePlayback? preparePlayback;

  /// Live subscription starts from WallScreen after a verified boot.
  final LiveWallSession? liveSession;

  /// Party-scoped effects persistence.
  final SettingsPort? settings;

  /// Durable remote index and cache used by recovery and offline boot.
  final ManifestIndexStore? manifestIndexStore;
  final CacheStore? cacheStore;

  /// Diagnostic detail for a disabled/incomplete live configuration.
  final String? remoteUnavailableReason;

  Future<bool> _readEffectsDisabled() async {
    final SettingsPort? port = settings;
    if (port == null) return false;
    try {
      return await port.getBool(
            partyId: PartyId(partyId),
            key: CctvWallSettingsKeys.effectsDisabled,
          ) ??
          false;
    } on Object {
      return false;
    }
  }

  /// Restores the party-scoped camera display cap before wall construction.
  ///
  /// Party-scoped string key [CctvWallSettingsKeys.cameraCount] with encoding
  /// `'1'`/`'2'`/`'4'`; absent, invalid, or unreadable values default to 4
  /// ([kDefaultCctvClipCount]), keeping the existing four-camera default.
  Future<int> _readCameraCount() async {
    final SettingsPort? port = settings;
    if (port == null) return kDefaultCctvClipCount;
    try {
      final String? raw = await port.getString(
        partyId: PartyId(partyId),
        key: CctvWallSettingsKeys.cameraCount,
      );
      if (raw != null) {
        final int? parsed = int.tryParse(raw.trim());
        if (parsed != null && isSupportedCctvClipCount(parsed)) {
          return parsed;
        }
      }
    } on Object {
      // Unreadable counts keep the four-camera default.
    }
    return kDefaultCctvClipCount;
  }

  Future<WallBootResult> _ready({
    required ChannelRegistry registry,
    required ChannelPlugin plugin,
    required PlaybackManifest manifest,
    required bool usedCachedManifest,
    Map<String, CachedMedia> mediaByClipId = const <String, CachedMedia>{},
    bool effectsDisabled = false,
  }) async => WallBootResult.ready(
    registry: registry,
    plugin: plugin,
    manifest: manifest,
    usedCachedManifest: usedCachedManifest,
    mediaByClipId: mediaByClipId,
    liveSession: liveSession,
    settings: settings,
    initialEffectsDisabled: effectsDisabled,
    initialCameraCount: await _readCameraCount(),
    hostInviteClient: hostInviteClient,
    remoteUnavailableReason: remoteUnavailableReason,
  );

  Future<PlaybackManifest> _loadFallback() {
    if (fixture != null) {
      return Future<PlaybackManifest>.value(
        fixture!(partyId: partyId, channelId: channelId),
      );
    }
    if (fixtureLoader != null) {
      return fixtureLoader!(partyId: partyId, channelId: channelId);
    }
    return loadBundledFixtureManifest(
      partyId: partyId,
      channelId: channelId,
      loader: bundleLoader,
    );
  }

  /// Verifies every clip's sha256 + size against the bundled asset bytes.
  /// Any mismatch, unknown asset, or load failure fails closed (false).
  ///
  /// Fail-closed verified/played-byte identity: tiles play
  /// `assetPathForCamera(cameraId)` ([WallScreen]), so a manifest whose
  /// `assetPathForClip` resolves anywhere else (e.g. a swapped-asset
  /// manifest where CAM-01 names cam04's bytes with cam04's sha) is
  /// rejected even when its digests match the named file. Both [boot] and
  /// [readCached] go through this check.
  Future<bool> _verifyManifestBytes(PlaybackManifest manifest) async {
    final WallAssetBytesLoader load =
        assetBytesLoader ?? defaultAssetBytesLoader;
    for (final ClipDescriptor clip in manifest.clips) {
      final String? assetPath = assetPathForClip(clip);
      if (assetPath == null) {
        return false;
      }
      final String playedPath;
      try {
        playedPath = assetPathForCamera(clip.cameraId);
      } on ArgumentError {
        return false;
      }
      if (assetPath != playedPath) {
        return false;
      }
      late final List<int> bytes;
      try {
        bytes = await load(assetPath);
      } catch (_) {
        return false;
      }
      if (bytes.length != clip.sizeBytes) {
        return false;
      }
      if (sha256Hex(bytes).toLowerCase() != clip.sha256.toLowerCase()) {
        return false;
      }
    }
    return true;
  }

  /// Runs the boot sequence. Never throws: failures become
  /// [WallBootResult.unavailable] so the app can show a status screen.
  Future<WallBootResult> boot() async {
    final ChannelRegistry registry;
    try {
      registry = registryFactory();
    } catch (error) {
      return WallBootResult.unavailable('CHANNEL REGISTRY FAILED · $error');
    }

    final ChannelPlugin? plugin = registry.resolve(
      hauntedSurveillanceChannelId,
    );
    if (plugin == null) {
      return const WallBootResult.unavailable(
        'NO WALL · channel "$hauntedSurveillanceChannelId" is not registered',
      );
    }

    // The durable remote index is distinct from PrefsManifestStore and the
    // bundled fixture. In particular, a bundled v1 can never reserve backend
    // v1 or cause a same-version remote conflict.
    final PreparePlayback? preparation = preparePlayback;
    if (preparation != null) {
      final PlaybackSyncSnapshot offline = await preparation.bootOffline(
        partyId: partyId,
        channelId: channelId,
      );
      if (offline.state == PlaybackSyncState.usingCache &&
          offline.hasCompleteMedia &&
          offline.manifest != null) {
        return await _ready(
          registry: registry,
          plugin: plugin,
          manifest: offline.manifest!,
          usedCachedManifest: true,
          mediaByClipId: offline.mediaByClipId,
          effectsDisabled: await _readEffectsDisabled(),
        );
      }
    }

    PlaybackManifest? cached;
    try {
      cached = await store.read();
    } catch (_) {
      cached = null;
    }

    // Prefer the last known good manifest, but only when it belongs to this
    // party + channel and its bytes still verify; a corrupt cache falls back
    // to the bundled fixture instead of blacking out the TV.
    if (cached != null &&
        cached.partyId == partyId &&
        cached.channelId == channelId) {
      final Result<PlaybackManifest> cachedCheck = validateCctvManifest(cached);
      if (cachedCheck is Ok<PlaybackManifest> &&
          await _verifyManifestBytes(cachedCheck.value)) {
        return await _ready(
          registry: registry,
          plugin: plugin,
          manifest: cachedCheck.value,
          usedCachedManifest: true,
          effectsDisabled: await _readEffectsDisabled(),
        );
      }
      // A cached manifest for another party/channel, or one whose bytes no
      // longer verify, is treated as a miss (falls through to the bundle).
    }

    late final PlaybackManifest fallback;
    try {
      fallback = await _loadFallback();
    } catch (error) {
      return WallBootResult.unavailable(
        'WALL UNAVAILABLE · bundled fixture failed: $error',
      );
    }
    final Result<PlaybackManifest> fallbackCheck = validateCctvManifest(
      fallback,
    );
    if (fallbackCheck is Err<PlaybackManifest>) {
      return WallBootResult.unavailable(
        'WALL UNAVAILABLE · ${fallbackCheck.message}',
      );
    }
    final PlaybackManifest manifest =
        (fallbackCheck as Ok<PlaybackManifest>).value;
    if (!await _verifyManifestBytes(manifest)) {
      return const WallBootResult.unavailable(
        'WALL UNAVAILABLE · bundled clip hash mismatch',
      );
    }

    // First boot (or repaired cache): persist the fixture so the next start
    // restores a wall even if the fixture pipeline changes.
    try {
      await store.write(manifest);
    } catch (_) {
      // Non-fatal: the wall still plays, it just will not be cached.
    }

    return await _ready(
      registry: registry,
      plugin: plugin,
      manifest: manifest,
      usedCachedManifest: false,
      effectsDisabled: await _readEffectsDisabled(),
    );
  }

  /// Reads the durable committed version for the recovery action without
  /// disturbing an in-flight live preparation.
  Future<VerifiedWallPlayback?> readCommittedPlayback() async {
    final ManifestIndexStore? indexStore = manifestIndexStore;
    final CacheStore? cache = cacheStore;
    if (indexStore == null || cache == null) return null;
    try {
      final CommittedManifestIndex? index = await indexStore.readCommitted(
        partyId: partyId,
        channelId: channelId,
      );
      if (index == null) return null;
      final Map<String, CachedMedia> media = <String, CachedMedia>{};
      for (final ClipDescriptor clip in index.manifest.clips) {
        final CachedMedia? cached = await cache.findVerified(clip);
        if (cached == null ||
            cached.localRef != index.localRefFor(clip) ||
            cached.clipId != clip.id ||
            cached.sha256.toLowerCase() != clip.sha256.toLowerCase()) {
          return null;
        }
        media[clip.id] = cached;
      }
      return VerifiedWallPlayback(index.manifest, media);
    } on Object {
      return null;
    }
  }

  /// Reads + validates the cached manifest (recovery "retry cached wall").
  /// Returns null when nothing valid is stored.
  Future<PlaybackManifest?> readCached() async {
    try {
      final PlaybackManifest? cached = await store.read();
      if (cached == null) {
        return null;
      }
      if (cached.partyId != partyId || cached.channelId != channelId) {
        return null;
      }
      final Result<PlaybackManifest> checked = validateCctvManifest(cached);
      if (checked is! Ok<PlaybackManifest>) {
        return null;
      }
      if (!await _verifyManifestBytes(checked.value)) {
        return null;
      }
      return checked.value;
    } catch (_) {
      return null;
    }
  }
}

/// A complete, re-verified remote version available for manual recovery.
final class VerifiedWallPlayback {
  VerifiedWallPlayback(this.manifest, Map<String, CachedMedia> mediaByClipId)
    : mediaByClipId = Map<String, CachedMedia>.unmodifiable(mediaByClipId);

  final PlaybackManifest manifest;
  final Map<String, CachedMedia> mediaByClipId;
}
