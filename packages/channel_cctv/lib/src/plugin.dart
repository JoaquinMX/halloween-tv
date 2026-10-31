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
typedef CctvTileBuilder =
    Widget Function(
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
) => Container(
  color: Colors.black,
  child: Center(
    child: Text('NO FEED · $cameraId', style: CctvTheme.timestampStyle),
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

  /// Party-scoped display cap for the number of visible cameras.
  ///
  /// Encoding: the string `'1'`, `'2'`, or `'4'` (persisted through the
  /// contracts-layer `SettingsPort` as a string, scoped by party id).
  /// Absent, invalid, or unreadable values default to `'4'` (four cameras).
  ///
  /// This is a DISPLAY CAP only: `effectiveCount = min(configuredCount,
  /// manifest clip count)`. Reduced layouts still prepare + ACK the complete
  /// received manifest, and generation presets keep producing 4 clips. See
  /// [cctvCameraCountFromSettings] and [cctvEffectiveCount].
  static const String cameraCount = 'cameraCount';

  /// Transient hero-zoom target: the camera id shown fullscreen, or absent
  /// for the grid. Never persisted; validated against the active slots
  /// (unknown ids are ignored). See [cctvHeroCameraIdFromSettings].
  static const String heroCameraId = 'heroCameraId';
}

/// Animation duration for grid relayouts and hero zoom in/out.
///
/// Shared by the wall and its tests so intermediate hero geometry can be
/// asserted deterministically (pump a fraction of this duration).
const Duration kWallLayoutDuration = Duration(milliseconds: 250);

/// Key of the wall root (layout + hero geometry assertions).
const ValueKey<String> kCctvWallKey = ValueKey<String>('cctv-wall');

/// Reads the configured camera display cap from [settings].
///
/// Accepts the documented string encoding (`'1'`/`'2'`/`'4'`, surrounding
/// whitespace tolerated) and, defensively, a raw int. Anything absent,
/// invalid, or unreadable (wrong type, unparsable, unsupported count such
/// as `3`) defaults to [kDefaultCctvClipCount] (four cameras).
int cctvCameraCountFromSettings(ChannelSettings settings) {
  final Object? raw = settings.values[CctvWallSettingsKeys.cameraCount];
  final int? parsed = raw is String
      ? int.tryParse(raw.trim())
      : raw is int
      ? raw
      : null;
  if (parsed == null || !isSupportedCctvClipCount(parsed)) {
    return kDefaultCctvClipCount;
  }
  return parsed;
}

/// Reads the transient hero-zoom target from [settings].
///
/// Returns the camera id when a non-empty string is present, else null
/// (grid). Membership in the active slot set is validated by the wall, not
/// here, so unknown ids degrade to the grid instead of taking it down.
String? cctvHeroCameraIdFromSettings(ChannelSettings settings) {
  final Object? raw = settings.values[CctvWallSettingsKeys.heroCameraId];
  if (raw is! String || raw.isEmpty) {
    return null;
  }
  return raw;
}

/// Derives the number of tiles the wall renders.
///
/// `effectiveCount = min(configuredCount, manifestClipCount)`: the setting
/// can only ever HIDE cameras, never invent them. Both inputs are sanitized
/// to supported counts first (unsupported configured values fall back to
/// [kDefaultCctvClipCount]; an unsupported manifest length falls back to the
/// full slot map so per-slot defaults degrade instead of crashing). Because
/// the supported counts `{1, 2, 4}` are closed under `min`, the result is
/// always a supported count.
int cctvEffectiveCount({
  required int configuredCount,
  required int manifestClipCount,
}) {
  final int configured = isSupportedCctvClipCount(configuredCount)
      ? configuredCount
      : kDefaultCctvClipCount;
  final int manifest = isSupportedCctvClipCount(manifestClipCount)
      ? manifestClipCount
      : cctvSlots.length;
  return configured < manifest ? configured : manifest;
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
/// effects, and timed-events capabilities. [build] assembles the adaptive
/// 1/2/4-camera wall shell, delegating video surfaces to the app layer via
/// PlaybackHandle + [tileBuilder].
final class HauntedSurveillancePlugin implements ChannelPlugin {
  /// Creates the plugin.
  const HauntedSurveillancePlugin({
    this.tileBuilder = _defaultTileSurface,
    this.profile,
    this.manifest,
    this.clock = const SystemClock(),
    this.disableEffects = false,
    this.glitchSeed = 0xc0ffee,
    this.cameraCount = kDefaultCctvClipCount,
    this.heroCameraId,
  });

  /// Builds per-tile video surfaces (app-owned player lifecycles).
  final CctvTileBuilder tileBuilder;

  /// Effect profile applied to tile overlays; defaults to [cctvProfile].
  final EffectProfile? profile;

  /// Optional playback manifest; clip camera ids drive the wall slots via
  /// [tileForClip] (canonical [cctvSlots] order, never manifest clip order),
  /// otherwise [tileFor] defaults apply. Manifests with 1, 2, or 4 clips
  /// (the supported layouts) map their clips onto the matching slots;
  /// anything else degrades to per-slot defaults instead of taking the
  /// wall down. The rendered tile count is capped by [cameraCount].
  final PlaybackManifest? manifest;

  /// Clock source for tile HUD timestamps.
  final Clock clock;

  /// Drops effect overlays (tests / hidden recovery overlay).
  final bool disableEffects;

  /// Seed for the wall glitch controller (deterministic replay).
  final int glitchSeed;

  /// Configured camera display cap (1, 2, or 4; defaults to 4).
  ///
  /// Direct-use default only: [build] prefers [CctvWallSettingsKeys.cameraCount]
  /// from [ChannelContext.settings] when present. The rendered tile count is
  /// `min(configured, manifest clips)` (see [cctvEffectiveCount]).
  final int cameraCount;

  /// Transient hero-zoom target (camera id shown fullscreen), or null for
  /// the grid. Direct-use default only: [build] prefers
  /// [CctvWallSettingsKeys.heroCameraId] when present.
  final String? heroCameraId;

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
    final bool settingsDisabled = context.settings.get<bool>(
      CctvWallSettingsKeys.effectsDisabled,
      false,
    );
    // `cameraCount` follows the same rule (present settings win, absent
    // settings keep the constructor default for direct use); the hero target
    // is transient UI state that is never persisted, so a settings value
    // wins when present and the constructor default applies otherwise.
    final bool hasCountOverride = context.settings.values.containsKey(
      CctvWallSettingsKeys.cameraCount,
    );
    return CctvWall(
      playbackHandle: context.playbackHandle,
      tileBuilder: tileBuilder,
      profile:
          profile ??
          (manifest == null
              ? cctvProfile()
              : effectProfileFromOverlay(manifest!.overlay)),
      manifest: manifest,
      clock: clock,
      disableEffects: disableEffects || settingsDisabled,
      glitchSeed: glitchSeed,
      labelOverrides: cctvLabelOverridesFromSettings(context.settings),
      cameraCount: hasCountOverride
          ? cctvCameraCountFromSettings(context.settings)
          : cameraCount,
      heroCameraId:
          cctvHeroCameraIdFromSettings(context.settings) ?? heroCameraId,
    );
  }
}

/// Adaptive CCTV wall shell (1, 2, or 4 cameras + decoder-preserving hero).
///
/// Boots by preparing the app-owned [PlaybackHandle], then shows one
/// full-size tile, two side-by-side tiles in one row, or a 2x2 grid in
/// canonical camera order, driven by [cameraCount] (display cap) and the
/// received manifest (see [cctvEffectiveCount]). A single tile
/// failure never takes down the wall: surface builders that throw are
/// caught per tile and render [SignalLost].
///
/// Grid and hero geometry live in one full-viewport [Stack] with
/// camera-keyed [AnimatedPositioned] children whose ancestry remains stable:
/// opening the hero ([heroCameraId]) animates the selected existing tile to
/// the viewport rectangle and fades its siblings (they stay mounted, so no
/// decoder is created or disposed during the zoom). The host (app layer)
/// owns focus and key handling; the wall only presents geometry.
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
    this.cameraCount = kDefaultCctvClipCount,
    this.heroCameraId,
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

  /// Configured camera display cap (1, 2, or 4).
  ///
  /// Unsupported values degrade to [kDefaultCctvClipCount]. The rendered
  /// tile count is `min(cameraCount, manifest clips)` (see
  /// [cctvEffectiveCount]): a display cap only, never a prepare/ACK filter —
  /// the host still prepares and acknowledges the complete received
  /// manifest.
  final int cameraCount;

  /// Transient hero-zoom target (camera id shown fullscreen), or null for
  /// the grid. Unknown ids (not in the active slots) degrade to the grid.
  final String? heroCameraId;

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
      _glitchTimer = Timer.periodic(widget.glitchTick, (_) => _glitch.tick());
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
      _glitchTimer = Timer.periodic(widget.glitchTick, (_) => _glitch.tick());
    }
  }

  @override
  void dispose() {
    _glitchTimer?.cancel();
    _glitch.dispose();
    super.dispose();
  }

  /// Active wall slots in canonical order: the first `effectiveCount`
  /// `core_playlist` [CctvSlot]s, where `effectiveCount =
  /// min(cameraCount, manifest clips)` (see [cctvEffectiveCount]).
  ///
  /// Slot placement always follows camera identity (`cctvSlots` order), never
  /// manifest clip order, so a reordered control-plane payload cannot move a
  /// feed to the wrong tile. Clips present in the manifest drive their slot
  /// via [tileForClip]: the clip `label` wins when present, else the
  /// `core_playlist` slot default applies (owner Q3). Manifests with
  /// unsupported lengths, or naming unknown cameras, fall back to the static
  /// [tileFor] defaults per slot instead of taking the wall down.
  /// Per-camera label overrides from [ChannelContext.settings] apply on top.
  ///
  /// Only the active slots are returned, so the host builds sources and
  /// decoders for active ids only. Reducing the count never filters the
  /// manifest itself: the host still prepares and ACKs the complete
  /// received manifest.
  List<({String label, String cameraId})> _slots() {
    final PlaybackManifest? manifest = widget.manifest;
    final Map<String, ClipDescriptor> byCamera = <String, ClipDescriptor>{};
    if (manifest != null && isSupportedCctvClipCount(manifest.clips.length)) {
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
    final List<({String label, String cameraId})> labelled =
        widget.labelOverrides.isEmpty
        ? base
        : <({String label, String cameraId})>[
            for (final ({String label, String cameraId}) slot in base)
              (
                label: widget.labelOverrides[slot.cameraId] ?? slot.label,
                cameraId: slot.cameraId,
              ),
          ];
    final int effective = cctvEffectiveCount(
      configuredCount: widget.cameraCount,
      manifestClipCount: manifest?.clips.length ?? cctvSlots.length,
    );
    return labelled.take(effective).toList();
  }

  /// Grid cell rectangles tiling [size] for [count] tiles.
  ///
  /// One tile fills the padded viewport; two tiles sit side by side in one
  /// row; four tiles form the canonical 2x2 grid (index 0 top-left, reading
  /// order). The 4px outer pad preserves the gutter look of the previous
  /// Column/Row layout; every rect stays inside [size] (viewport bounds).
  List<Rect> _gridRects(Size size, int count) {
    const double pad = 4;
    const double gap = 4;
    final double width = size.width;
    final double height = size.height;
    switch (count) {
      case 1:
        return <Rect>[
          Rect.fromLTWH(pad, pad, width - pad * 2, height - pad * 2),
        ];
      case 2:
        final double cellWidth = (width - pad * 2 - gap) / 2;
        final double cellHeight = height - pad * 2;
        return <Rect>[
          Rect.fromLTWH(pad, pad, cellWidth, cellHeight),
          Rect.fromLTWH(pad + cellWidth + gap, pad, cellWidth, cellHeight),
        ];
      default:
        final double cellWidth = (width - pad * 2 - gap) / 2;
        final double cellHeight = (height - pad * 2 - gap) / 2;
        return <Rect>[
          Rect.fromLTWH(pad, pad, cellWidth, cellHeight),
          Rect.fromLTWH(pad + cellWidth + gap, pad, cellWidth, cellHeight),
          Rect.fromLTWH(pad, pad + cellHeight + gap, cellWidth, cellHeight),
          Rect.fromLTWH(
            pad + cellWidth + gap,
            pad + cellHeight + gap,
            cellWidth,
            cellHeight,
          ),
        ];
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_ready) {
      return const Center(child: CircularProgressIndicator());
    }
    // One full-viewport Stack sizes the wall from the incoming constraints
    // (720p through 1080p, including the host's overscan-safe padding) with
    // no scrollable and no overflow. Camera-keyed AnimatedPositioned
    // children keep a stable ancestry across grid relayouts and hero zoom,
    // so shared camera elements (and their decoders) survive both.
    final List<({String label, String cameraId})> slots = _slots();
    final String? hero =
        widget.heroCameraId != null &&
            slots.any(
              (({String label, String cameraId}) slot) =>
                  slot.cameraId == widget.heroCameraId,
            )
        ? widget.heroCameraId
        : null;
    return Container(
      key: kCctvWallKey,
      color: CctvTheme.gutter,
      child: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          final Size size = constraints.biggest;
          final List<Rect> rects = _gridRects(size, slots.length);
          return Stack(
            children: <Widget>[
              for (int index = 0; index < slots.length; index++)
                AnimatedPositioned(
                  key: ValueKey<String>('wall-slot-${slots[index].cameraId}'),
                  duration: kWallLayoutDuration,
                  left: hero == slots[index].cameraId ? 0 : rects[index].left,
                  top: hero == slots[index].cameraId ? 0 : rects[index].top,
                  width: hero == slots[index].cameraId
                      ? size.width
                      : rects[index].width,
                  height: hero == slots[index].cameraId
                      ? size.height
                      : rects[index].height,
                  child: AnimatedOpacity(
                    duration: kWallLayoutDuration,
                    opacity: hero == null || hero == slots[index].cameraId
                        ? 1
                        : 0,
                    // Faded siblings stay mounted (decoders alive) but leave
                    // hit-testing to the hero tile.
                    child: IgnorePointer(
                      ignoring: hero != null && hero != slots[index].cameraId,
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
                    ),
                  ),
                ),
            ],
          );
        },
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
      return const CctvTile(hasError: true, child: SizedBox.shrink());
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
