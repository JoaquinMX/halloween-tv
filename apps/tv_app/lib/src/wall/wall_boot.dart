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

import '../media/feed_assets.dart';
import 'manifest_store.dart';

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
  }) : unavailableReason = null;

  /// No wall can be shown; [unavailableReason] is user-facing.
  const WallBootResult.unavailable(this.unavailableReason)
      : registry = null,
        plugin = null,
        manifest = null,
        usedCachedManifest = false;

  /// Channel registry built during boot.
  final ChannelRegistry? registry;

  /// Resolved active channel plugin.
  final ChannelPlugin? plugin;

  /// Validated manifest driving the wall.
  final PlaybackManifest? manifest;

  /// True when the wall came from the last cached manifest (not the bundle).
  final bool usedCachedManifest;

  /// Why the wall is unavailable, when it is.
  final String? unavailableReason;

  /// Whether a wall can be rendered.
  bool get isReady => plugin != null && manifest != null;
}

/// Builds the channel registry; injectable so tests can simulate a registry
/// without the haunted-surveillance channel.
typedef WallRegistryFactory = ChannelRegistry Function();

/// Builds the offline fallback manifest (legacy sync override, tests only).
typedef WallManifestFixture = PlaybackManifest Function({
  required String partyId,
  required String channelId,
});

/// Loads the bundled fixture manifest JSON text (injected in tests so a
/// missing bundle file does not need the real asset pipeline).
typedef WallBundleLoader = Future<String> Function(String assetKey);

/// Loads raw bytes for a bundled asset path (injected in tests).
typedef WallAssetBytesLoader = Future<List<int>> Function(String assetPath);

/// Async fallback-manifest loader (bundled `fixture_manifest.json`).
typedef WallFixtureLoader = Future<PlaybackManifest> Function({
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
    this.registryFactory = defaultWallRegistry,
    this.fixture,
    this.fixtureLoader,
    this.assetBytesLoader,
    this.bundleLoader = defaultBundleLoader,
  });

  /// Last-known-good manifest persistence.
  final WallManifestStore store;

  /// Party the wall belongs to.
  final String partyId;

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

  Future<PlaybackManifest> _loadFallback() {
    if (fixture != null) {
      return Future<PlaybackManifest>.value(
        fixture!(partyId: partyId, channelId: hauntedSurveillanceChannelId),
      );
    }
    if (fixtureLoader != null) {
      return fixtureLoader!(
        partyId: partyId,
        channelId: hauntedSurveillanceChannelId,
      );
    }
    return loadBundledFixtureManifest(
      partyId: partyId,
      channelId: hauntedSurveillanceChannelId,
      loader: bundleLoader,
    );
  }

  /// Verifies every clip's sha256 + size against the bundled asset bytes.
  /// Any mismatch, unknown asset, or load failure fails closed (false).
  Future<bool> _verifyManifestBytes(PlaybackManifest manifest) async {
    final WallAssetBytesLoader load =
        assetBytesLoader ?? defaultAssetBytesLoader;
    for (final ClipDescriptor clip in manifest.clips) {
      final String? assetPath = assetPathForClip(clip);
      if (assetPath == null) {
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

    final ChannelPlugin? plugin = registry.resolve(hauntedSurveillanceChannelId);
    if (plugin == null) {
      return const WallBootResult.unavailable(
        'NO WALL · channel "$hauntedSurveillanceChannelId" is not registered',
      );
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
        cached.channelId == hauntedSurveillanceChannelId) {
      final Result<PlaybackManifest> cachedCheck = validateCctvManifest(cached);
      if (cachedCheck is Ok<PlaybackManifest> &&
          await _verifyManifestBytes(cachedCheck.value)) {
        return WallBootResult.ready(
          registry: registry,
          plugin: plugin,
          manifest: cachedCheck.value,
          usedCachedManifest: true,
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
    final Result<PlaybackManifest> fallbackCheck =
        validateCctvManifest(fallback);
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

    return WallBootResult.ready(
      registry: registry,
      plugin: plugin,
      manifest: manifest,
      usedCachedManifest: false,
    );
  }

  /// Reads + validates the cached manifest (recovery "retry cached wall").
  /// Returns null when nothing valid is stored.
  Future<PlaybackManifest?> readCached() async {
    try {
      final PlaybackManifest? cached = await store.read();
      if (cached == null) {
        return null;
      }
      if (cached.partyId != partyId ||
          cached.channelId != hauntedSurveillanceChannelId) {
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
