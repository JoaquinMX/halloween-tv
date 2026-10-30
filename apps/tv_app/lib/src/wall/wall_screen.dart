/// Hosts the haunted-surveillance channel wall for one party.
library;

import 'dart:async';
import 'dart:io';

import 'package:channel_cctv/channel_cctv.dart';
import 'package:core_cache/core_cache.dart';
import 'package:core_effects/core_effects.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:core_ui/core_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kernel_app/kernel_app.dart';
import 'package:tv_app/src/media/feed_assets.dart';
import 'package:tv_app/src/playback/camera_tile.dart';
import 'package:tv_app/src/playback/tile_video_controller.dart';
import 'package:tv_app/src/wall/guest_code_panel.dart';
import 'package:tv_app/src/wall/guest_codes.dart';
import 'package:tv_app/src/wall/live_wall_session.dart';
import 'package:tv_app/src/wall/playback_handle.dart';
import 'package:tv_app/src/wall/recovery_overlay.dart';
import 'package:tv_app/src/wall/wall_boot.dart';
import 'package:tv_app/src/wall/wall_focus.dart';

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
    this.mediaByClipId = const <String, CachedMedia>{},
    this.liveSession,
    this.settings,
    this.profile,
    this.partyId = 'local-party',
    this.tvDeviceId = '',
    this.channelId = hauntedSurveillanceChannelId,
    this.guestCodeClient,
    this.glitchSeed = 0x4A11,
    this.onRetryCached,
    this.onRetryCachedPlayback,
    this.fileExists,
    this.recoveryEnabled = true,
    this.initialEffectsDisabled = false,
    this.overscanPadding = const EdgeInsets.symmetric(
      horizontal: 28,
      vertical: 18,
    ),
    this.longPressDuration = const Duration(milliseconds: 600),
    this.sourceSettleTimeout = const Duration(seconds: 15),
  });

  /// Channel plugin resolved from the kernel registry.
  final ChannelPlugin plugin;

  /// Wall manifest driving camera slots.
  final PlaybackManifest manifest;

  /// Builds one decoder per tile.
  final TileVideoControllerFactory tileControllerFactory;

  /// Clock used by the tile HUDs (injectable for deterministic tests).
  final Clock clock;

  /// Verified committed files keyed by manifest clip id.
  final Map<String, CachedMedia> mediaByClipId;

  /// Live subscription started after offline rendering.
  final LiveWallSession? liveSession;

  /// Party-scoped persistent settings.
  final SettingsPort? settings;

  /// Effect profile for tile overlays; defaults to [cctvProfile].
  final EffectProfile? profile;

  /// Party this wall belongs to.
  final String partyId;

  /// TV's own device code, shown on the host guest-code page.
  final String tvDeviceId;

  /// Active channel for the guest-code join payload.
  final String channelId;

  /// Host guest-code reader; null keeps the recovery panel on its actions
  /// only (offline builds never list codes).
  final GuestCodeClient? guestCodeClient;

  /// Seed for the wall's deterministic glitch bursts.
  final int glitchSeed;

  /// Reloads the last cached manifest; null result means "nothing cached".
  final Future<PlaybackManifest?> Function()? onRetryCached;

  /// Re-verifies the durable remote index without interrupting live work.
  final Future<VerifiedWallPlayback?> Function()? onRetryCachedPlayback;

  /// Existence check for verified local files.
  ///
  /// Defaults to real `File(path).exists()`. Injectable because `testWidgets`
  /// bodies run in a FakeAsync zone where real dart:io never completes;
  /// production passes nothing and keeps the real filesystem check.
  final Future<bool> Function(String path)? fileExists;

  /// Whether OK long-press / MENU reveals the recovery panel.
  final bool recoveryEnabled;

  /// Starts with effect overlays dropped.
  final bool initialEffectsDisabled;

  /// Extra padding keeping HUD text inside the TV's overscan-safe area.
  final EdgeInsets overscanPadding;

  /// How long OK must be held to reveal the recovery panel.
  final Duration longPressDuration;

  /// Bound for one tile source replacement to settle.
  ///
  /// Defaults to 15s. Injectable so tests do not stall real seconds on
  /// decoder failure and prod can tune it alongside other timeouts.
  final Duration sourceSettleTimeout;

  @override
  State<WallScreen> createState() => _WallScreenState();
}

class _WallScreenState extends State<WallScreen> {
  late final WallFocusController _focus;
  late final WallPlaybackHandle _handle;

  late PlaybackManifest _manifest;
  late Map<String, CachedMedia> _mediaByClipId;
  late Map<String, TileMediaSource> _tileSources;
  final Map<String, Completer<bool>> _sourceSettles =
      <String, Completer<bool>>{};
  final Set<String> _initialSettledCameras = <String>{};
  bool _liveStarted = false;
  late bool _effectsDisabled;
  bool _recoveryVisible = false;
  bool _guestCodesVisible = false;
  bool _guestCodesLoading = false;
  List<GuestCodeEntry>? _guestCodes;
  String? _guestCodesError;
  bool _okHeld = false;
  bool _activatedHandle = false;
  String? _status;
  String? _recoveryStatus;
  Timer? _okHoldTimer;
  final FocusNode _recoveryFocus = FocusNode(debugLabel: 'recovery-primary');

  @override
  void initState() {
    super.initState();
    _focus = WallFocusController();
    _manifest = widget.manifest;
    _mediaByClipId = Map<String, CachedMedia>.of(widget.mediaByClipId);
    _tileSources = _sourcesFor(_manifest, _mediaByClipId);
    _effectsDisabled = widget.initialEffectsDisabled;
    _handle = WallPlaybackHandle(
      prepareAction: _prepareCurrentVersion,
      activateAction: _activateCurrentVersion,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _activatedHandle) {
        return;
      }
      _activatedHandle = true;
      unawaited(_bootHandle());
    });
  }

  @override
  void dispose() {
    _okHoldTimer?.cancel();
    _recoveryFocus.dispose();
    _focus.dispose();
    for (final Completer<bool> settle in _sourceSettles.values) {
      if (!settle.isCompleted) settle.complete(false);
    }
    final LiveWallSession? session = widget.liveSession;
    if (session != null) unawaited(session.dispose());
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
      source: _tileSources[cameraId]!,
      focusNode: _focus.nodeAt(index),
      controllerFactory: widget.tileControllerFactory,
      onSourceSettled: (bool success) {
        final Completer<bool>? settle = _sourceSettles[cameraId];
        if (settle != null && !settle.isCompleted) settle.complete(success);
      },
      onInitialSettled: () => _onInitialTileSettled(cameraId),
      autofocus: index == 0,
      onFocusChange: (bool hasFocus) {
        if (hasFocus) {
          _focus.markFocused(index);
        }
      },
    );
  }

  void _onInitialTileSettled(String cameraId) {
    _initialSettledCameras.add(cameraId);
    if (!_liveStarted &&
        _initialSettledCameras.length == cctvCameraIds.length) {
      _liveStarted = true;
      widget.liveSession?.start(activate: _activateLiveVersion);
    }
  }

  Future<void> _bootHandle() async {
    try {
      await _handle.prepare();
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _status = 'OFFLINE VERIFY FAILED · KEEPING CURRENT FEED';
        _recoveryStatus = error.toString();
      });
      return;
    }
    if (!mounted) return;
    try {
      await _handle.activate();
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _status = 'WALL ACTIVATE FAILED · KEEPING CURRENT FEED';
        _recoveryStatus = error.toString();
      });
    }
  }

  Future<void> _prepareCurrentVersion() =>
      _verifyPlayableSources(_manifest, _mediaByClipId);

  Future<void> _activateCurrentVersion() async {
    if (!mounted) throw StateError('wall has been disposed');
    _restoreTileFocus();
  }

  Future<void> _activateLiveVersion(PlaybackSyncSnapshot snapshot) async {
    final PlaybackManifest? manifest = snapshot.manifest;
    if (manifest == null || !snapshot.hasCompleteMedia) {
      throw StateError('live activation requires complete verified media');
    }
    final WallPlaybackHandle staged = WallPlaybackHandle(
      prepareAction: () =>
          _verifyPlayableSources(manifest, snapshot.mediaByClipId),
      activateAction: () =>
          _applyVerifiedVersion(manifest, snapshot.mediaByClipId),
    );
    await staged.prepare();
    await staged.activate();
  }

  Future<void> _verifyPlayableSources(
    PlaybackManifest manifest,
    Map<String, CachedMedia> mediaByClipId,
  ) async {
    final Future<bool> Function(String path) exists =
        widget.fileExists ?? _realFileExists;
    for (final TileMediaSource source in _sourcesFor(
      manifest,
      mediaByClipId,
    ).values) {
      if (source case LocalFileSource(:final path)) {
        if (!await exists(path)) {
          throw FileSystemException('verified playback file is missing', path);
        }
      }
    }
  }

  static Future<bool> _realFileExists(String path) =>
      File(path).exists();


  Map<String, TileMediaSource> _sourcesFor(
    PlaybackManifest manifest,
    Map<String, CachedMedia> mediaByClipId,
  ) {
    final Map<String, TileMediaSource> sources = <String, TileMediaSource>{};
    for (final String cameraId in cctvCameraIds) {
      final ClipDescriptor clip = manifest.clips.firstWhere(
        (ClipDescriptor value) => value.cameraId == cameraId,
      );
      final CachedMedia? cached = mediaByClipId[clip.id];
      if (cached != null) {
        if (cached.clipId != clip.id ||
            cached.sha256.toLowerCase() != clip.sha256.toLowerCase() ||
            cached.localRef.trim().isEmpty) {
          throw StateError('verified media entry does not match ${clip.id}');
        }
        sources[cameraId] = LocalFileSource(cached.localRef);
        continue;
      }
      if (mediaByClipId.isNotEmpty) {
        throw StateError('committed media is missing ${clip.id}');
      }
      final String? assetPath = assetPathForClip(clip);
      sources[cameraId] = BundledAssetSource(
        assetPath ?? assetPathForCamera(cameraId),
      );
    }
    return sources;
  }

  Future<void> _applyVerifiedVersion(
    PlaybackManifest manifest,
    Map<String, CachedMedia> mediaByClipId,
  ) async {
    if (!mounted) throw StateError('wall has been disposed');
    final Map<String, TileMediaSource> oldSources =
        Map<String, TileMediaSource>.of(_tileSources);
    final Map<String, TileMediaSource> targetSources = _sourcesFor(
      manifest,
      mediaByClipId,
    );
    final List<String> switched = <String>[];
    try {
      for (final String cameraId in cctvCameraIds) {
        final TileMediaSource target = targetSources[cameraId]!;
        if (oldSources[cameraId] == target) continue;
        if (!await _replaceTileSource(cameraId, target)) {
          throw StateError('decoder rejected replacement for $cameraId');
        }
        switched.add(cameraId);
      }
    } on Object {
      for (final String cameraId in switched.reversed) {
        await _replaceTileSource(cameraId, oldSources[cameraId]!);
      }
      if (mounted) setState(() => _tileSources = oldSources);
      rethrow;
    }
    if (!mounted) throw StateError('wall was disposed during activation');
    setState(() {
      _manifest = manifest;
      _mediaByClipId = Map<String, CachedMedia>.of(mediaByClipId);
      _tileSources = targetSources;
      _status = 'WALL UPDATED · v${manifest.version}';
    });
  }

  Future<bool> _replaceTileSource(
    String cameraId,
    TileMediaSource source,
  ) async {
    if (_tileSources[cameraId] == source) return true;
    final Completer<bool> settled = Completer<bool>();
    _sourceSettles[cameraId] = settled;
    setState(() => _tileSources[cameraId] = source);
    await WidgetsBinding.instance.endOfFrame;
    try {
      return await settled.future.timeout(widget.sourceSettleTimeout);
    } finally {
      if (identical(_sourceSettles[cameraId], settled)) {
        _sourceSettles.remove(cameraId);
      }
    }
  }

  /// Builds the resolved channel with this app's surfaces.
  ///
  /// The registry owns the channel (descriptor, profile, clock, glitch
  /// configuration); the app must inject its decoder surfaces
  /// ([CctvTileBuilder]), so a shallow copy preserving the registry
  /// object's configuration is built. Live wall state (effects flag,
  /// manifest version, overscan safety) additionally travels via
  /// [ChannelContext.settings], which [HauntedSurveillancePlugin.build]
  /// honors — registry object and copy can never diverge on wall config.
  /// Tile widgets keep stable cameraId-based keys and swap feeds in place
  /// ([CameraTile.didUpdateWidget] disposes before creating), so a cached
  /// retry never transiently doubles the decoder count.
  ChannelPlugin _configuredChannel() {
    final ChannelPlugin resolved = widget.plugin;
    if (resolved is HauntedSurveillancePlugin) {
      return HauntedSurveillancePlugin(
        tileBuilder: _buildTile,
        profile: widget.profile ?? resolved.profile,
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

  /// Opens the host guest-code page and loads the guest list once.
  ///
  /// Offline builds never reach here (no GUEST CODES button without a
  /// [GuestCodeClient]); a read failure stays inline on the panel and keeps
  /// the TV code + QR visible.
  void _openGuestCodes() {
    final GuestCodeClient? client = widget.guestCodeClient;
    if (!mounted || _guestCodesVisible || client == null) {
      return;
    }
    setState(() {
      _guestCodesVisible = true;
      _guestCodesLoading = true;
      _guestCodesError = null;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _guestCodesVisible) {
        _recoveryFocus.requestFocus();
      }
    });
    client.fetchGuestCodes().then((List<GuestCodeEntry> entries) {
      if (!mounted) {
        return;
      }
      setState(() {
        _guestCodes = entries;
        _guestCodesLoading = false;
      });
    }, onError: (Object error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _guestCodesLoading = false;
        _guestCodesError = error is GuestCodeException
            ? error.message
            : 'unexpected guest list failure';
      });
    });
  }

  /// Returns from the guest-code page to the recovery actions.
  void _closeGuestCodes() {
    setState(() {
      _guestCodesVisible = false;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _recoveryVisible) {
        _recoveryFocus.requestFocus();
      }
    });
  }

  void _closeRecovery() {
    setState(() {
      _recoveryVisible = false;
      _guestCodesVisible = false;
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
    final Future<VerifiedWallPlayback?> Function()? retryPlayback =
        widget.onRetryCachedPlayback;
    if (retryPlayback != null) {
      VerifiedWallPlayback? restored;
      try {
        restored = await retryPlayback();
      } on Object {
        restored = null;
      }
      if (restored != null) {
        try {
          await _activateLiveVersion(
            PlaybackSyncSnapshot(
              state: PlaybackSyncState.ready,
              manifest: restored.manifest,
              mediaByClipId: restored.mediaByClipId,
            ),
          );
        } on Object {
          if (mounted) {
            setState(() {
              _recoveryStatus = 'Cached media could not be activated.';
              _status = 'CACHE RESTORE FAILED · KEEPING CURRENT FEED';
            });
          }
          return;
        }
        if (!mounted) return;
        setState(() {
          _recoveryVisible = false;
          _recoveryStatus = null;
        });
        _restoreTileFocus();
        return;
      }
    }
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
    if (reloaded == null) {
      setState(() {
        _recoveryStatus = 'No cached wall stored yet.';
        _status = 'NO CACHED WALL · KEEPING CURRENT FEED';
      });
      return;
    }
    final PlaybackManifest restored = reloaded;
    try {
      await _applyVerifiedVersion(restored, const <String, CachedMedia>{});
    } on Object {
      if (mounted) {
        setState(() {
          _recoveryStatus = 'Cached wall could not be activated.';
          _status = 'CACHE RESTORE FAILED · KEEPING CURRENT FEED';
        });
      }
      return;
    }
    if (mounted) {
      setState(() {
        _recoveryVisible = false;
        _recoveryStatus = null;
        _status = 'WALL RESTORED · v${restored.version}';
      });
      _restoreTileFocus();
    }
  }

  void _toggleEffects() {
    final bool value = !_effectsDisabled;
    setState(() {
      _effectsDisabled = value;
      _status = _effectsDisabled ? 'EFFECTS DISABLED' : 'EFFECTS ENABLED';
    });
    final SettingsPort? settings = widget.settings;
    if (settings != null) {
      unawaited(
        settings.setBool(
          partyId: PartyId(widget.partyId),
          key: CctvWallSettingsKeys.effectsDisabled,
          value: value,
        ),
      );
    }
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
      // Wall config travels through the channel contract so
      // HauntedSurveillancePlugin.build applies it without the host
      // discarding the registry object.
      settings: ChannelSettings(<String, Object?>{
        CctvWallSettingsKeys.effectsDisabled: _effectsDisabled,
        CctvWallSettingsKeys.manifestVersion: _manifest.version,
        CctvWallSettingsKeys.overscanSafe: true,
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
                // Stable key: tiles keep cameraId-based keys across retries
                // and swap feeds in place instead of remounting (which would
                // transiently double the decoder count).
                child: KeyedSubtree(
                  key: ValueKey<String>('wall-${widget.partyId}'),
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
                child: _guestCodesVisible
                  ? GuestCodePanel(
                      partyId: widget.partyId,
                      tvDeviceId: widget.tvDeviceId,
                      channelId: widget.channelId,
                      joinPayload: buildJoinPayload(
                        partyId: widget.partyId,
                        deviceId: widget.tvDeviceId,
                        channelId: widget.channelId,
                      ),
                      guests: _guestCodes,
                      isLoadingGuests: _guestCodesLoading,
                      guestsError: _guestCodesError,
                      primaryFocusNode: _recoveryFocus,
                      onBack: _closeGuestCodes,
                      onClose: _closeRecovery,
                    )
                  : RecoveryOverlay(
                      effectsDisabled: _effectsDisabled,
                      statusMessage: _recoveryStatus,
                      primaryFocusNode: _recoveryFocus,
                      onRetryCached: () => unawaited(_retryCached()),
                      onToggleEffects: _toggleEffects,
                      onClose: _closeRecovery,
                      onShowGuestCodes: widget.guestCodeClient == null
                          ? null
                          : _openGuestCodes,
                    ),
              ),
            ),
        ],
      ),
    );
  }
}
