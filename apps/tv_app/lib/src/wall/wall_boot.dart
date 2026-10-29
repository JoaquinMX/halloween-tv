/// Boot sequence: kernel registry -> channels -> manifest -> wall.
library;

import 'package:channel_cctv/channel_cctv.dart';
import 'package:channel_retro_tv/channel_retro_tv.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:kernel_app/kernel_app.dart';
import 'package:testing_toolkit/testing_toolkit.dart';

import 'manifest_store.dart';

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

  /// True when the wall came from the last cached manifest (not the fixture).
  final bool usedCachedManifest;

  /// Why the wall is unavailable, when it is.
  final String? unavailableReason;

  /// Whether a wall can be rendered.
  bool get isReady => plugin != null && manifest != null;
}

/// Builds the channel registry; injectable so tests can simulate a registry
/// without the haunted-surveillance channel.
typedef WallRegistryFactory = ChannelRegistry Function();

/// Builds the offline fallback manifest.
typedef WallManifestFixture = PlaybackManifest Function({
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

PlaybackManifest _fixtureFor({
  required String partyId,
  required String channelId,
}) =>
    manifestFixture(partyId: partyId, channelId: channelId);

/// Boots the microkernel and restores the wall manifest.
final class WallBoot {
  /// Creates the boot sequence.
  const WallBoot({
    this.store = const PrefsManifestStore(),
    this.partyId = 'local-party',
    this.registryFactory = defaultWallRegistry,
    this.fixture = _fixtureFor,
  });

  /// Last-known-good manifest persistence.
  final WallManifestStore store;

  /// Party the wall belongs to.
  final String partyId;

  /// Registry factory (channel registration).
  final WallRegistryFactory registryFactory;

  /// Offline fallback manifest.
  final WallManifestFixture fixture;

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
      return WallBootResult.unavailable(
        'NO WALL · channel "$hauntedSurveillanceChannelId" is not registered',
      );
    }

    PlaybackManifest? cached;
    try {
      cached = await store.read();
    } catch (_) {
      cached = null;
    }

    // Prefer the last known good manifest, but never let a corrupt cache
    // black out the TV: an invalid cache falls back to the bundled fixture.
    if (cached != null) {
      final Result<PlaybackManifest> cachedCheck = validateCctvManifest(cached);
      if (cachedCheck is Ok<PlaybackManifest>) {
        return WallBootResult.ready(
          registry: registry,
          plugin: plugin,
          manifest: cachedCheck.value,
          usedCachedManifest: true,
        );
      }
    }

    final PlaybackManifest fallback =
        fixture(partyId: partyId, channelId: hauntedSurveillanceChannelId);
    final Result<PlaybackManifest> fallbackCheck =
        validateCctvManifest(fallback);
    if (fallbackCheck is Err<PlaybackManifest>) {
      return WallBootResult.unavailable(
        'WALL UNAVAILABLE · ${fallbackCheck.message}',
      );
    }
    final PlaybackManifest manifest =
        (fallbackCheck as Ok<PlaybackManifest>).value;

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
      final Result<PlaybackManifest> checked = validateCctvManifest(cached);
      return checked is Ok<PlaybackManifest> ? checked.value : null;
    } catch (_) {
      return null;
    }
  }
}
