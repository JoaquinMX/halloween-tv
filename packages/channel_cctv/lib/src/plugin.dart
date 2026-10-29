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

/// ChannelContext.settings keys honored by [HauntedSurveillancePlugin.build].
///
/// Wall configuration travels through the channel contract (not through
/// plugin re-instantiation): the app publishes its live wall state here and
/// [HauntedSurveillancePlugin.build] applies it. Constructor fields remain
/// as defaults for direct use; settings win when present so the registry
/// object and any app-side copy can never diverge on wall config.
class CctvWallSettingsKeys {
  /// When `true`, drops effect overlays and glitch ticking.
  static const String effectsDisabled = 'effectsDisabled';

  /// Wall manifest version the app currently displays (diagnostics only).
  static const String manifestVersion = 'manifestVersion';

  /// Whether the host pads HUD content into the overscan-safe area.
  static const String overscanSafe = 'overscanSafe';

  /// Optional per-camera label overrides (`{cameraId: label}`).
  static const String labels = 'labels';
}

/// Reads per-camera label overrides from [settings].
///
/// Accepts any `Map` shape (the settings map is untyped) and keeps only
/// string-keyed, string-valued entries.
Map<String, String> cctvLabelOverridesFromSettings(ChannelSettings settings) {
  final Object? raw = settings.values[CctvWallSettingsKeys.labels];
  if (raw is! Map) {
    return const <String, String>{};
  }
  final Map<String, String> out = <String, String>{};
  for (final MapEntry<dynamic, dynamic> entry in raw.entries) {
    if (entry.key is String && entry.value is String) {
      out[entry.key as String] = entry.value as String;
    }
  }
  return out;
}

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
  Widget build(ChannelContext context) {
    // Wall config flows through the channel contract: settings published by
    // the host win over constructor defaults, so the registry object never
    // needs to be discarded/re-instantiated to change wall behaviour.
    final bool settingsDisabled = context.settings
        .get<bool>(CctvWallSettingsKeys.effectsDisabled, false);
    return CctvWall(
      playbackHandle: context.playbackHandle,
      tileBuilder: tileBuilder,
      profile: profile ??
          (manifest == null
              ? cctvProfile()
              : effectProfileFromOverlay(manifest!.overlay)),
      manifest: manifest,
      clock: clock,
      disableEffects: disableEffects || settingsDisabled,
      glitchSeed: glitchSeed,
      labelOverrides: cctvLabelOverridesFromSettings(context.settings),
    );
  }
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
    this.labelOverrides = const <String, String>{},
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

  /// Per-camera label overrides applied on top of the slot map
  /// (`{cameraId: label}`); empty means no overrides.
  final Map<String, String> labelOverrides;

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
  void didUpdateWidget(CctvWall oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Reconcile the glitch ticker when effect state changes (e.g. the
    // recovery panel toggles effects OFF -> ON): a stale timer must not
    // keep ticking while disabled, and re-enabling must restart it.
    if (oldWidget.disableEffects != widget.disableEffects) {
      if (widget.disableEffects) {
        _glitchTimer?.cancel();
        _glitchTimer = null;
        _glitch.reset();
      } else {
        _glitchTimer ??= Timer.periodic(
          widget.glitchTick,
          (_) => _glitch.tick(),
        );
      }
    } else if (!widget.disableEffects &&
        oldWidget.glitchTick != widget.glitchTick) {
      _glitchTimer?.cancel();
      _glitchTimer = Timer.periodic(
        widget.glitchTick,
        (_) => _glitch.tick(),
      );
    }
  }

  @override
  void dispose() {
    _glitchTimer?.cancel();
    _glitch.dispose();
    super.dispose();
  }

  /// Wall slots in canonical order, one per `core_playlist` [CctvSlot].
  ///
  /// Slot placement always follows camera identity (`cctvSlots` order), never
  /// manifest clip order, so a reordered control-plane payload cannot move a
  /// feed to the wrong tile. When the manifest carries one clip per slot, the
  /// clip drives the tile via [tileForClip]: its `label` wins when present,
  /// else the `core_playlist` slot default applies (owner Q3). Manifests that
  /// are short, oversized, or name unknown cameras fall back to the static
  /// [tileFor] defaults per slot instead of taking the wall down.
  /// Per-camera label overrides from [ChannelContext.settings] apply on top.
  List<({String label, String cameraId})> _slots() {
    final PlaybackManifest? manifest = widget.manifest;
    final Map<String, ClipDescriptor> byCamera = <String, ClipDescriptor>{};
    if (manifest != null && manifest.clips.length == cctvSlots.length) {
      for (final ClipDescriptor clip in manifest.clips) {
        byCamera.putIfAbsent(clip.cameraId, () => clip);
      }
    }
    final List<({String label, String cameraId})> base =
        <({String label, String cameraId})>[
      for (final CctvSlot slot in cctvSlots)
        if (byCamera[slot.id] case final ClipDescriptor clip)
          tileForClip(clip)
        else
          tileFor(slot.index),
    ];
    if (widget.labelOverrides.isEmpty) {
      return base;
    }
    return <({String label, String cameraId})>[
      for (final ({String label, String cameraId}) slot in base)
        (
          label: widget.labelOverrides[slot.cameraId] ?? slot.label,
          cameraId: slot.cameraId,
        ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    if (!_ready) {
      return const Center(child: CircularProgressIndicator());
    }
    // 2x2 wall sized by the viewport: Column/Row of Expanded cells fills
    // exactly the incoming constraints (720p through 1080p, including the
    // host's overscan-safe padding) with no scrollable and no overflow.
    // A fixed GridView cross-axis layout cannot guarantee this: without a
    // viewport-derived childAspectRatio the bottom row renders off-screen.
    final List<({String label, String cameraId})> slots = _slots();
    Widget cell(int index) => Expanded(
          child: Padding(
            padding: const EdgeInsets.all(2),
            child: _WallTile(
              index: index,
              label: slots[index].label,
              cameraId: slots[index].cameraId,
              tileBuilder: widget.tileBuilder,
              profile: widget.profile,
              clock: widget.clock,
              disableEffects: widget.disableEffects,
              glitch: _glitch,
              bootFailed: _bootFailed,
            ),
          ),
        );
    return Container(
      color: CctvTheme.gutter,
      padding: const EdgeInsets.all(4),
      child: Column(
        children: <Widget>[
          Expanded(
            child: Row(
              children: <Widget>[cell(0), cell(1)],
            ),
          ),
          Expanded(
            child: Row(
              children: <Widget>[cell(2), cell(3)],
            ),
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
