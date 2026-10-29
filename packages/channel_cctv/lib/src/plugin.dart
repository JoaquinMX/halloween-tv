/// Haunted-surveillance channel plugin + 2x2 wall shell.
library;

import 'dart:async';

import 'package:channel_api/channel_api.dart';
import 'package:core_effects/core_effects.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:core_ui/core_ui.dart';
import 'package:flutter/material.dart';

import 'cctv_tiles.dart';

/// Builds the video surface for one wall tile.
///
/// The channel never touches a concrete player: the app layer implements
/// this callback (owning `VideoPlayerController` lifecycles) and the wall
/// wraps the returned surface in [CctvTile] chrome.
typedef CctvTileBuilder = Widget Function(
  BuildContext context,
  int index,
  String label,
  String cameraId,
);

/// Placeholder surface used when the app supplies no [CctvTileBuilder].
Widget _defaultTileSurface(
  BuildContext context,
  int index,
  String label,
  String cameraId,
) =>
    Container(
      color: Colors.black,
      child: Center(
        child: Text(
          'NO FEED · $cameraId',
          style: CctvTheme.timestampStyle,
        ),
      ),
    );

/// Channel id for the haunted-surveillance feed.
const String hauntedSurveillanceChannelId = 'haunted_surveillance';

/// Derives the tile effect profile from manifest [OverlaySettings].
///
/// Manifest overlay values are already bounded to `0..1` by the playlist
/// contract, so they map straight onto [EffectSpec] intensities.
EffectProfile effectProfileFromOverlay(OverlaySettings overlay) =>
    EffectProfile(<EffectSpec>[
      EffectSpec(EffectType.scanlines, overlay.scanlineOpacity),
      EffectSpec(EffectType.vignette, overlay.vignette),
      EffectSpec(EffectType.noise, overlay.noiseLevel),
    ]);

/// Haunted-surveillance CCTV channel plugin.
///
/// Descriptor id is [hauntedSurveillanceChannelId] with video-playback,
/// effects, and timed-events capabilities. [build] assembles the 2x2 wall
/// shell, delegating video surfaces to the app layer via PlaybackHandle +
/// [tileBuilder].
final class HauntedSurveillancePlugin implements ChannelPlugin {
  /// Creates the plugin.
  const HauntedSurveillancePlugin({
    this.tileBuilder = _defaultTileSurface,
    this.profile,
    this.manifest,
    this.clock = const SystemClock(),
    this.disableEffects = false,
    this.glitchSeed = 0xc0ffee,
  });

  /// Builds per-tile video surfaces (app-owned player lifecycles).
  final CctvTileBuilder tileBuilder;

  /// Effect profile applied to tile overlays; defaults to [cctvProfile].
  final EffectProfile? profile;

  /// Optional playback manifest; when it carries exactly four clips their
  /// camera ids drive the wall slots, otherwise [tileFor] defaults apply.
  final PlaybackManifest? manifest;

  /// Clock source for tile HUD timestamps.
  final Clock clock;

  /// Drops effect overlays (tests / hidden recovery overlay).
  final bool disableEffects;

  /// Seed for the wall glitch controller (deterministic replay).
  final int glitchSeed;

  @override
  ChannelDescriptor get descriptor => const ChannelDescriptor(
        id: hauntedSurveillanceChannelId,
        title: 'Haunted Surveillance',
        version: 1,
        capabilities: ChannelCapability(
          videoPlayback: true,
          effects: true,
          timedEvents: true,
        ),
      );

  @override
  Widget build(ChannelContext context) => CctvWall(
        playbackHandle: context.playbackHandle,
        tileBuilder: tileBuilder,
        profile: profile ??
            (manifest == null
                ? cctvProfile()
                : effectProfileFromOverlay(manifest!.overlay)),
        manifest: manifest,
        clock: clock,
        disableEffects: disableEffects,
        glitchSeed: glitchSeed,
      );
}

/// 2x2 CCTV wall shell.
///
/// Boots by preparing the app-owned [PlaybackHandle], then shows four
/// [CctvTile]s (video surface + HUD + effect overlay). A single tile
/// failure never takes down the wall: surface builders that throw are
/// caught per tile and render [SignalLost].
class CctvWall extends StatefulWidget {
  /// Creates the wall shell.
  CctvWall({
    super.key,
    required this.playbackHandle,
    this.tileBuilder = _defaultTileSurface,
    EffectProfile? profile,
    this.manifest,
    this.clock = const SystemClock(),
    this.disableEffects = false,
    this.glitchSeed = 0xc0ffee,
    this.glitchTick = const Duration(milliseconds: 700),
  }) : profile = profile ?? cctvProfile();

  /// Opaque app-owned playback control surface.
  final PlaybackHandle playbackHandle;

  /// Builds per-tile video surfaces.
  final CctvTileBuilder tileBuilder;

  /// Effect profile applied to tile overlays.
  final EffectProfile profile;

  /// Optional manifest overriding the default camera slot map.
  final PlaybackManifest? manifest;

  /// Clock source for tile HUD timestamps.
  final Clock clock;

  /// Drops effect overlays and glitch ticking.
  final bool disableEffects;

  /// Seed for the wall glitch controller.
  final int glitchSeed;

  /// Cadence of glitch-controller ticks.
  final Duration glitchTick;

  @override
  State<CctvWall> createState() => _CctvWallState();
}

class _CctvWallState extends State<CctvWall> {
  late final GlitchController _glitch;
  Timer? _glitchTimer;
  bool _ready = false;
  bool _bootFailed = false;

  @override
  void initState() {
    super.initState();
    _glitch = GlitchController(seed: widget.glitchSeed);
    if (!widget.disableEffects) {
      _glitchTimer =
          Timer.periodic(widget.glitchTick, (_) => _glitch.tick());
    }
    unawaited(_boot());
  }

  Future<void> _boot() async {
    bool failed = false;
    try {
      await widget.playbackHandle.prepare();
    } catch (_) {
      // A failed coordinator boot must not take the wall down: every tile
      // degrades to the SIGNAL LOST fallback instead.
      failed = true;
    }
    if (!mounted) {
      return;
    }
    setState(() {
      _ready = true;
      _bootFailed = failed;
    });
  }

  @override
  void dispose() {
    _glitchTimer?.cancel();
    _glitch.dispose();
    super.dispose();
  }

  /// Camera ids driving the four slots: manifest clips when exactly four
  /// are present, otherwise the static [tileFor] map.
  List<({String label, String cameraId})> _slots() {
    final PlaybackManifest? manifest = widget.manifest;
    if (manifest != null && manifest.clips.length == 4) {
      return <({String label, String cameraId})>[
        for (final ClipDescriptor clip in manifest.clips)
          (label: '${clip.cameraId} · ${clip.id}', cameraId: clip.cameraId),
      ];
    }
    return <({String label, String cameraId})>[
      tileFor(0),
      tileFor(1),
      tileFor(2),
      tileFor(3),
    ];
  }

  @override
  Widget build(BuildContext context) {
    if (!_ready) {
      return const Center(child: CircularProgressIndicator());
    }
    final List<({String label, String cameraId})> slots = _slots();
    return Container(
      color: CctvTheme.gutter,
      child: GridView.count(
        crossAxisCount: 2,
        padding: const EdgeInsets.all(4),
        mainAxisSpacing: 4,
        crossAxisSpacing: 4,
        physics: const NeverScrollableScrollPhysics(),
        children: <Widget>[
          for (int i = 0; i < 4; i++)
            _WallTile(
              index: i,
              label: slots[i].label,
              cameraId: slots[i].cameraId,
              tileBuilder: widget.tileBuilder,
              profile: widget.profile,
              clock: widget.clock,
              disableEffects: widget.disableEffects,
              glitch: _glitch,
              bootFailed: _bootFailed,
            ),
        ],
      ),
    );
  }
}

/// One wall slot: safe surface build + tile chrome.
class _WallTile extends StatelessWidget {
  const _WallTile({
    required this.index,
    required this.label,
    required this.cameraId,
    required this.tileBuilder,
    required this.profile,
    required this.clock,
    required this.disableEffects,
    required this.glitch,
    required this.bootFailed,
  });

  final int index;
  final String label;
  final String cameraId;
  final CctvTileBuilder tileBuilder;
  final EffectProfile profile;
  final Clock clock;
  final bool disableEffects;
  final GlitchController glitch;
  final bool bootFailed;

  @override
  Widget build(BuildContext context) {
    if (bootFailed) {
      return const CctvTile(hasError: true, child: SizedBox.shrink());
    }
    Widget surface;
    try {
      surface = tileBuilder(context, index, label, cameraId);
    } catch (_) {
      return const CctvTile(
        hasError: true,
        child: SizedBox.shrink(),
      );
    }
    Widget? effects;
    if (!disableEffects) {
      effects = _TileEffects(profile: profile, glitch: glitch);
    }
    return CctvTile(
      disableEffects: disableEffects,
      effectOverlay: effects,
      hud: HudOverlay(label: label, clock: clock),
      child: surface,
    );
  }
}

/// Scanlines + vignette + seeded noise overlay for one tile.
class _TileEffects extends StatelessWidget {
  const _TileEffects({required this.profile, required this.glitch});

  final EffectProfile profile;
  final GlitchController glitch;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: glitch,
        builder: (BuildContext context, Widget? _) => CctvEffectsOverlay(
          profile: profile,
          glitchIntensity: glitch.currentIntensity,
        ),
      );
}
