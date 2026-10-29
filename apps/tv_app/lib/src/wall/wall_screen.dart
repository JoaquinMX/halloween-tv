/// Hosts the haunted-surveillance channel wall for one party.
library;

import 'dart:async';

import 'package:channel_api/channel_api.dart';
import 'package:channel_cctv/channel_cctv.dart';
import 'package:core_effects/core_effects.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:core_ui/core_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../media/feed_assets.dart';
import '../playback/camera_tile.dart';
import '../playback/tile_video_controller.dart';
import 'playback_handle.dart';
import 'recovery_overlay.dart';
import 'wall_focus.dart';

/// Key of the status banner shown above the wall after recovery actions.
const Key kWallStatusBannerKey = ValueKey<String>('wall-status-banner');

/// Key of the hidden recovery panel.
const Key kRecoveryOverlayKey = ValueKey<String>('recovery-overlay');

/// Resolved channel + manifest rendered full-screen on the TV.
///
/// Responsibilities kept in the app (design s4/s13):
///  * owns one [CameraTile] (hence one video decoder) per wall slot,
///  * D-pad focus traversal between the four tiles,
///  * hidden recovery panel (OK long-press / MENU) with "retry cached wall"
///    and "disable effects",
///  * overscan-safe padding and an app-level status line.
///
/// Channel chrome (HUD, scanlines/vignette, glitch, SIGNAL LOST frame) comes
/// from `channel_cctv` + `core_ui` + `core_effects`; the app supplies the
/// video surfaces through [HauntedSurveillancePlugin.tileBuilder].
class WallScreen extends StatefulWidget {
  /// Creates the wall host.
  const WallScreen({
    super.key,
    required this.plugin,
    required this.manifest,
    required this.tileControllerFactory,
    required this.clock,
    this.profile,
    this.partyId = 'local-party',
    this.glitchSeed = 0x4A11,
    this.onRetryCached,
    this.recoveryEnabled = true,
    this.initialEffectsDisabled = false,
    this.overscanPadding = const EdgeInsets.symmetric(
      horizontal: 28,
      vertical: 18,
    ),
    this.longPressDuration = const Duration(milliseconds: 600),
  });

  /// Channel plugin resolved from the kernel registry.
  final ChannelPlugin plugin;

  /// Wall manifest driving camera slots.
  final PlaybackManifest manifest;

  /// Builds one decoder per tile.
  final TileVideoControllerFactory tileControllerFactory;

  /// Clock used by the tile HUDs (injectable for deterministic tests).
  final Clock clock;

  /// Effect profile for tile overlays; defaults to [cctvProfile].
  final EffectProfile? profile;

  /// Party this wall belongs to.
  final String partyId;

  /// Seed for the wall's deterministic glitch bursts.
  final int glitchSeed;

  /// Reloads the last cached manifest; null result means "nothing cached".
  final Future<PlaybackManifest?> Function()? onRetryCached;

  /// Whether OK long-press / MENU reveals the recovery panel.
  final bool recoveryEnabled;

  /// Starts with effect overlays dropped.
  final bool initialEffectsDisabled;

  /// Extra padding keeping HUD text inside the TV's overscan-safe area.
  final EdgeInsets overscanPadding;

  /// How long OK must be held to reveal the recovery panel.
  final Duration longPressDuration;

  @override
  State<WallScreen> createState() => _WallScreenState();
}

class _WallScreenState extends State<WallScreen> {
  late final WallFocusController _focus;
  final WallPlaybackHandle _handle = WallPlaybackHandle();

  late PlaybackManifest _manifest;
  late bool _effectsDisabled;
  bool _recoveryVisible = false;
  bool _okHeld = false;
  bool _activatedHandle = false;
  int _wallGeneration = 0;
  String? _status;
  String? _recoveryStatus;
  Timer? _okHoldTimer;
  final FocusNode _recoveryFocus = FocusNode(debugLabel: 'recovery-primary');

  @override
  void initState() {
    super.initState();
    _focus = WallFocusController();
    _manifest = widget.manifest;
    _effectsDisabled = widget.initialEffectsDisabled;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _activatedHandle) {
        return;
      }
      _activatedHandle = true;
      unawaited(_handle.activate());
    });
  }

  @override
  void dispose() {
    _okHoldTimer?.cancel();
    _recoveryFocus.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// Wall slot builder: app-owned player lifecycle per tile.
  Widget _buildTile(
    BuildContext context,
    int index,
    String label,
    String cameraId,
  ) {
    return CameraTile(
      key: ValueKey<String>('camera-tile-$cameraId'),
      index: index,
      cameraId: cameraId,
      assetPath: assetPathForCamera(cameraId),
      focusNode: _focus.nodeAt(index),
      controllerFactory: widget.tileControllerFactory,
      autofocus: index == 0,
      onFocusChange: (bool hasFocus) {
        if (hasFocus) {
          _focus.markFocused(index);
        }
      },
    );
  }

  /// Builds the resolved channel with this app's surfaces + current config.
  ///
  /// The registry holds the channel; the app re-creates the CCTV plugin with
  /// its own `tileBuilder` and current effect/recovery state. Other channels
  /// are built exactly as registered.
  ChannelPlugin _configuredChannel() {
    final ChannelPlugin resolved = widget.plugin;
    if (resolved is HauntedSurveillancePlugin) {
      return HauntedSurveillancePlugin(
        tileBuilder: _buildTile,
        profile: widget.profile ?? cctvProfile(),
        manifest: _manifest,
        clock: widget.clock,
        disableEffects: _effectsDisabled,
        glitchSeed: widget.glitchSeed,
      );
    }
    return resolved;
  }

  void _openRecovery() {
    if (!mounted || _recoveryVisible) {
      return;
    }
    setState(() {
      _recoveryVisible = true;
      _recoveryStatus = null;
    });
    // The wall's focus exclusion hands focus back to the scope; pull it onto
    // the first recovery action so a D-pad lands inside the panel.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _recoveryVisible) {
        _recoveryFocus.requestFocus();
      }
    });
  }

  void _closeRecovery() {
    setState(() {
      _recoveryVisible = false;
      _recoveryStatus = null;
    });
    // D-pad focus returns to the tile the user was watching. Deferred to a
    // post-frame callback: while the overlay is still mounted this frame,
    // ExcludeFocus(excluding: true) rejects a synchronous requestFocus on
    // the wall tiles, so the request must run after the rebuild flips
    // excluding back to false (same path as _restoreTileFocus).
    _restoreTileFocus();
  }

  Future<void> _retryCached() async {
    final Future<PlaybackManifest?> Function()? retry = widget.onRetryCached;
    PlaybackManifest? reloaded;
    if (retry != null) {
      try {
        reloaded = await retry();
      } catch (_) {
        reloaded = null;
      }
    }
    if (!mounted) {
      return;
    }
    setState(() {
      if (reloaded == null) {
        _recoveryStatus = 'No cached wall stored yet.';
        _status = 'NO CACHED WALL · KEEPING CURRENT FEED';
      } else {
        _manifest = reloaded;
        _wallGeneration++;
        _recoveryVisible = false;
        _recoveryStatus = null;
        _status = 'WALL RESTORED · v${reloaded.version}';
      }
    });
    if (reloaded != null) {
      _restoreTileFocus();
    }
  }

  void _toggleEffects() {
    setState(() {
      _effectsDisabled = !_effectsDisabled;
      _status = _effectsDisabled ? 'EFFECTS DISABLED' : 'EFFECTS ENABLED';
    });
  }

  void _restoreTileFocus() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) {
        return;
      }
      final int index = _focus.focusedIndex;
      _focus.focusTile(index < 0 ? 0 : index);
    });
  }

  bool _isSelectKey(LogicalKeyboardKey key) =>
      key == LogicalKeyboardKey.select ||
      key == LogicalKeyboardKey.enter ||
      key == LogicalKeyboardKey.gameButtonA ||
      key == LogicalKeyboardKey.space;

  KeyEventResult _onWallKey(FocusNode node, KeyEvent event) {
    if (event is KeyDownEvent) {
      if (event.logicalKey == LogicalKeyboardKey.contextMenu ||
          event.logicalKey == LogicalKeyboardKey.gameButtonStart) {
        if (widget.recoveryEnabled) {
          _openRecovery();
        }
        return KeyEventResult.handled;
      }
      if (widget.recoveryEnabled && _isSelectKey(event.logicalKey)) {
        if (!_okHeld) {
          _okHeld = true;
          _okHoldTimer?.cancel();
          _okHoldTimer = Timer(widget.longPressDuration, _openRecovery);
        }
        return KeyEventResult.handled;
      }
      if (_focus.handleArrow(event.logicalKey)) {
        return KeyEventResult.handled;
      }
      return KeyEventResult.ignored;
    }
    if (event is KeyUpEvent && _isSelectKey(event.logicalKey)) {
      _okHeld = false;
      _okHoldTimer?.cancel();
      _okHoldTimer = null;
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    final ChannelPlugin channel = _configuredChannel();
    final ChannelContext channelContext = ChannelContext(
      partyId: PartyId(widget.partyId),
      playbackHandle: _handle,
      settings: ChannelSettings(<String, Object?>{
        'effectsDisabled': _effectsDisabled,
        'manifestVersion': _manifest.version,
        'overscanSafe': true,
      }),
    );

    return FocusTraversalGroup(
      child: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          // Key gate: arrows move tile focus, OK long-press / MENU opens
          // recovery. `canRequestFocus: false` keeps tile 0 the entry point.
          ExcludeFocus(
            excluding: _recoveryVisible,
            child: Focus(
              canRequestFocus: false,
              skipTraversal: true,
              onKeyEvent: _onWallKey,
              child: SafeArea(
                minimum: widget.overscanPadding,
                child: KeyedSubtree(
                  key: ValueKey<String>(
                    'wall-${_manifest.version}-$_wallGeneration',
                  ),
                  child: channel.build(channelContext),
                ),
              ),
            ),
          ),
          if (_status != null)
            Positioned(
              left: 24,
              right: 24,
              bottom: 20,
              child: IgnorePointer(
                child: Container(
                  key: kWallStatusBannerKey,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 10,
                  ),
                  color: const Color(0xCC000000),
                  child: Text(_status!, style: CctvTheme.badgeStyle),
                ),
              ),
            ),
          if (_recoveryVisible)
            Positioned.fill(
              child: KeyedSubtree(
                key: kRecoveryOverlayKey,
                child: RecoveryOverlay(
                  effectsDisabled: _effectsDisabled,
                  statusMessage: _recoveryStatus,
                  primaryFocusNode: _recoveryFocus,
                  onRetryCached: () => unawaited(_retryCached()),
                  onToggleEffects: _toggleEffects,
                  onClose: _closeRecovery,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
