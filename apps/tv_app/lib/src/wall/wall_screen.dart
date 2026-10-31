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
import 'package:tv_app/src/wall/host_code_panel.dart';
import 'package:tv_app/src/wall/host_codes.dart';
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
///  * owns one [CameraTile] (hence one video decoder) per ACTIVE wall slot
///    (the 1/2/4 display cap never filters prepare/verify/ACK, which always
///    cover the complete received manifest),
///  * D-pad focus traversal between the active tiles (suppressed in hero),
///  * decoder-preserving camera hero (short OK release zooms, BACK
///    restores), available even when recovery is disabled,
///  * hidden recovery panel (OK long-press / MENU) with "retry cached wall",
///    "disable effects", a D-pad-operable 1/2/4 camera selector, and the
///    separately labelled HOST QR + GUEST CODES destinations,
///  * overscan-safe padding and an app-level status line.
///
/// Channel chrome (HUD, scanlines/vignette, glitch, SIGNAL LOST frame) comes
/// from `channel_cctv` + `core_ui` + `core_effects`; the app supplies the
/// video surfaces through [HauntedSurveillancePlugin.tileBuilder]. Wall
/// configuration (effects flag, camera count, hero target, manifest
/// version, overscan safety) travels via [ChannelContext.settings], which
/// [HauntedSurveillancePlugin.build] honors.
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
    this.initialCameraCount = kDefaultCctvClipCount,
    this.hostInviteClient,
    this.hostDeviceClient,
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

  /// TV's own device code, authorizing the host-only listing/invite calls.
  ///
  /// Never rendered: no screen displays the raw TV device id to guests.
  final String tvDeviceId;

  /// Active channel for the guest-code join payload.
  final String channelId;

  /// Host guest-code reader; null keeps the recovery panel on its actions
  /// only (offline builds never list codes).
  final GuestCodeClient? guestCodeClient;

  /// Host-invite minter for the HOST QR destination; null hides the HOST QR
  /// button (offline builds stay on the recovery actions only).
  final HostInviteClient? hostInviteClient;

  /// Host-management reader/revoker for the HOST QR destination; null hides
  /// the active-host list inside the host panel (offline builds stay on
  /// invite-only). Authorization carries the TV's device id; device ids are
  /// never rendered.
  final HostDeviceClient? hostDeviceClient;

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

  /// Restored party-scoped camera display cap (1, 2, or 4; see
  /// [CctvWallSettingsKeys.cameraCount]). Unsupported values degrade to 4.
  /// Passed through [WallGate] from the boot-time settings restore, before
  /// wall construction.
  final int initialCameraCount;

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

  /// False when the boot manifest has an unsupported clip count: the wall
  /// renders the SIGNAL-LOST/cache state instead of throwing during
  /// construction (see initState).
  late bool _manifestSupported;
  final Map<String, Completer<bool>> _sourceSettles =
      <String, Completer<bool>>{};
  final Set<String> _initialSettledCameras = <String>{};
  bool _liveStarted = false;
  late bool _effectsDisabled;
  late int _cameraCount;
  String? _heroCameraId;
  int _heroOriginIndex = 0;
  bool _recoveryVisible = false;
  bool _guestCodesVisible = false;
  bool _hostCodesVisible = false;
  bool _selectHeld = false;
  DateTime? _selectDownAt;
  bool _holdFired = false;
  bool _awaitingSelectRelease = false;
  int _wallGeneration = 0;
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
    _cameraCount = _sanitizeCameraCount(widget.initialCameraCount);
    // Fail closed on an unsupported manifest length: an unexpected clip
    // count (anything but 1, 2, or 4) degrades to the SIGNAL-LOST/cache
    // state instead of throwing a StateError out of construction, which
    // would take down the whole wall element. Live updates carrying a bad
    // length are rejected the same way in _applyVerifiedVersion (previous
    // usable wall retained).
    _manifestSupported = isSupportedCctvClipCount(_manifest.clips.length);
    if (_manifestSupported) {
      _tileSources = _activeSources(_sourcesFor(_manifest, _mediaByClipId));
    } else {
      _tileSources = <String, TileMediaSource>{};
      _status = 'SIGNAL-LOST · UNSUPPORTED MANIFEST · KEEPING CACHED FEED';
      _recoveryStatus =
          'Unsupported manifest clip count '
          '(${_manifest.clips.length}); expected 1, 2, or 4.';
    }
    _focus.setActiveLayout(
      tiles: _effectiveCount,
      columns: _columnsFor(_effectiveCount),
    );
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
    _sourceSettles.clear();
    final LiveWallSession? session = widget.liveSession;
    if (session != null) unawaited(session.dispose());
    super.dispose();
  }

  /// Sanitizes a restored setting to a supported display cap (1, 2, or 4).
  static int _sanitizeCameraCount(int value) =>
      isSupportedCctvClipCount(value) ? value : kDefaultCctvClipCount;

  /// Grid width for a tile count: 1 column for a single tile, 2 otherwise
  /// (two side-by-side tiles share one row; four tiles form the 2x2 grid).
  static int _columnsFor(int count) => count == 1 ? 1 : 2;

  /// Rendered tile count: `min(configuredCount, manifest clips)`.
  ///
  /// The setting is a DISPLAY CAP only — it hides cameras, never filters
  /// prepare/verify/ACK, which always cover the complete received manifest.
  int get _effectiveCount => cctvEffectiveCount(
    configuredCount: _cameraCount,
    manifestClipCount: _manifest.clips.length,
  );

  /// Active camera ids in canonical wall order (the first-N slots).
  ///
  /// Because supported layouts are always a prefix of the canonical slots,
  /// indices stay stable across count changes and shared cameras keep their
  /// elements, decoders, and focus nodes.
  List<String> _activeCameraIds() => <String>[
    for (final CctvSlot slot in cctvSlots.take(_effectiveCount)) slot.id,
  ];

  /// Active camera ids for an incoming manifest (used before it is applied).
  List<String> _activeCameraIdsFor(PlaybackManifest manifest) {
    final int effective = cctvEffectiveCount(
      configuredCount: _cameraCount,
      manifestClipCount: manifest.clips.length,
    );
    return <String>[
      for (final CctvSlot slot in cctvSlots.take(effective)) slot.id,
    ];
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
    // Boot gating waits for the ACTIVE tiles only: reduced layouts start
    // live work once their visible tiles settle, without waiting for
    // unmounted cameras. Failed initial decoders count as settled (tiles
    // report unconditionally, including SIGNAL LOST).
    if (!_liveStarted &&
        _activeCameraIds().every(_initialSettledCameras.contains)) {
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

  static Future<bool> _realFileExists(String path) => File(path).exists();

  Map<String, TileMediaSource> _sourcesFor(
    PlaybackManifest manifest,
    Map<String, CachedMedia> mediaByClipId,
  ) {
    // Sources for EVERY received clip: prepare + verify always cover the
    // complete received manifest, even when the display cap hides cameras.
    // Tiles (and their decoders) are built for the active subset only (see
    // _activeSources); what the manifest carries is never filtered here.
    final Map<String, TileMediaSource> sources = <String, TileMediaSource>{};
    for (final ClipDescriptor clip in manifest.clips) {
      final String cameraId = clip.cameraId;
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

  /// Narrows full-manifest [sources] to the active tile set.
  ///
  /// Throws when an active camera has no source: an activation that cannot
  /// feed a visible tile must fail and retain the previous usable wall
  /// rather than render a hole.
  Map<String, TileMediaSource> _activeSources(
    Map<String, TileMediaSource> sources,
  ) {
    final List<String> active = _activeCameraIds();
    final Map<String, TileMediaSource> narrowed = <String, TileMediaSource>{};
    for (final String cameraId in active) {
      final TileMediaSource? source = sources[cameraId];
      if (source == null) {
        throw StateError('no verified source for active camera $cameraId');
      }
      narrowed[cameraId] = source;
    }
    return narrowed;
  }

  Future<void> _applyVerifiedVersion(
    PlaybackManifest manifest,
    Map<String, CachedMedia> mediaByClipId,
  ) async {
    // A live update with an unsupported clip count can never feed the
    // active tiles: fail BEFORE touching wall state so the previous usable
    // wall is retained untouched (same fail-closed rule as initState).
    if (!isSupportedCctvClipCount(manifest.clips.length)) {
      throw StateError(
        'unsupported manifest clip count ${manifest.clips.length}',
      );
    }
    // Staging cannot feed the active tiles: fail BEFORE touching wall state
    // so the previous usable wall is retained untouched.
    final Map<String, TileMediaSource> targetSources = _activeSources(
      _sourcesFor(manifest, mediaByClipId),
    );
    if (!mounted) throw StateError('wall has been disposed');
    final int generation = ++_wallGeneration;
    final Map<String, TileMediaSource> oldSources =
        Map<String, TileMediaSource>.of(_tileSources);
    final List<String> active = _activeCameraIdsFor(manifest);
    final List<String> switched = <String>[];
    try {
      // Source replacement runs for ACTIVE cameras only: obsolete callbacks
      // for unmounted tiles are never awaited (see _selectCameraCount,
      // which completes them immediately). Shared cameras keep their
      // elements by stable cameraId keys and swap feeds in place.
      for (final String cameraId in active) {
        if (generation != _wallGeneration) {
          throw StateError('wall version superseded during activation');
        }
        final TileMediaSource target = targetSources[cameraId]!;
        if (oldSources[cameraId] == target) continue;
        if (!await _replaceTileSource(cameraId, target)) {
          throw StateError('decoder rejected replacement for $cameraId');
        }
        switched.add(cameraId);
      }
    } on Object {
      // Roll back only when no newer version took over meanwhile: a
      // superseded activation must not clobber the newer wall state.
      if (generation == _wallGeneration) {
        for (final String cameraId in switched.reversed) {
          await _replaceTileSource(cameraId, oldSources[cameraId]!);
        }
        if (mounted) setState(() => _tileSources = oldSources);
      }
      rethrow;
    }
    if (generation != _wallGeneration) {
      throw StateError('wall version superseded during activation');
    }
    if (!mounted) throw StateError('wall was disposed during activation');
    setState(() {
      _manifest = manifest;
      _mediaByClipId = Map<String, CachedMedia>.of(mediaByClipId);
      _tileSources = targetSources;
      // The active set may have changed (1/2/4 manifests): reconcile hero
      // and focus geometry against the new wall before it renders.
      _reconcileLayout();
      _status = 'WALL UPDATED · v${manifest.version}';
    });
  }

  Future<bool> _replaceTileSource(
    String cameraId,
    TileMediaSource source,
  ) async {
    if (_tileSources[cameraId] == source) return true;
    // The camera left the active set (count change / new manifest): nothing
    // to swap — its tile is unmounted and the map no longer carries it.
    if (!_activeCameraIds().contains(cameraId)) return true;
    final int generation = _wallGeneration;
    final Completer<bool> settled = Completer<bool>();
    _sourceSettles[cameraId] = settled;
    setState(() => _tileSources[cameraId] = source);
    await WidgetsBinding.instance.endOfFrame;
    if (generation != _wallGeneration || !mounted) return false;
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
  /// effective camera count, hero target, manifest version, overscan
  /// safety) additionally travels via [ChannelContext.settings], which
  /// [HauntedSurveillancePlugin.build] honors — registry object and copy
  /// can never diverge on wall config.
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

  void _openRecovery({bool deferFocus = false}) {
    if (!mounted || _recoveryVisible) {
      return;
    }
    setState(() {
      _recoveryVisible = true;
      _recoveryStatus = null;
    });
    if (deferFocus) {
      // The held key keeps tile focus until its release (see _onWallKey):
      // focusing the panel now would hand auto-repeat arrivals to the
      // focused button and fire its action while still held.
      return;
    }
    // The wall's focus exclusion hands focus back to the scope; pull it onto
    // the first recovery action so a D-pad lands inside the panel.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _recoveryVisible) {
        _recoveryFocus.requestFocus();
      }
    });
  }

  /// Opens the host guest-code page.
  ///
  /// Offline builds never reach here (no GUEST CODES button without a
  /// [GuestCodeClient]). The panel owns its authoritative listing refresh
  /// (immediate fetch plus bounded interval); the wall only shows/hides it.
  void _openGuestCodes() {
    final GuestCodeClient? client = widget.guestCodeClient;
    if (!mounted || _guestCodesVisible || client == null) {
      return;
    }
    setState(() {
      _guestCodesVisible = true;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _guestCodesVisible) {
        _recoveryFocus.requestFocus();
      }
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

  /// Opens the host invite (HOST QR) page.
  ///
  /// Offline builds never reach here (no HOST QR button without a
  /// [HostInviteClient]). The panel owns its invite mint (immediate fetch
  /// plus manual REFRESH and an expiry ticker); the wall only shows/hides it.
  void _openHostCodes() {
    final HostInviteClient? client = widget.hostInviteClient;
    if (!mounted || _hostCodesVisible || client == null) {
      return;
    }
    setState(() {
      _hostCodesVisible = true;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _hostCodesVisible) {
        _recoveryFocus.requestFocus();
      }
    });
  }

  /// Returns from the host invite page to the recovery actions.
  void _closeHostCodes() {
    setState(() {
      _hostCodesVisible = false;
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
      _hostCodesVisible = false;
      _awaitingSelectRelease = false;
      _recoveryStatus = null;
    });
    // D-pad focus returns to the tile the user was watching (in hero, the
    // origin tile keeps focus throughout, so this restores it). Deferred to
    // a post-frame callback: while the overlay is still mounted this frame,
    // ExcludeFocus(excluding: true) rejects a synchronous requestFocus on
    // the wall tiles, so the request must run after the rebuild flips
    // excluding back to false (same path as _restoreTileFocus).
    _restoreTileFocus();
  }

  /// Reconciles hero + focus geometry against the current active set.
  ///
  /// Must run inside setState after a count change or manifest activation:
  /// settles for unmounted tiles are completed immediately (never waited
  /// on), a hero whose origin camera disappeared exits, and removed focus
  /// is clamped to a valid remaining tile.
  void _reconcileLayout() {
    final List<String> active = _activeCameraIds();
    for (final String cameraId in _sourceSettles.keys.toList()) {
      if (!active.contains(cameraId)) {
        _sourceSettles.remove(cameraId)?.complete(false);
      }
    }
    if (_heroCameraId != null && !active.contains(_heroCameraId)) {
      _heroCameraId = null;
    }
    _focus.setActiveLayout(
      tiles: active.length,
      columns: _columnsFor(active.length),
    );
  }

  /// Selects the camera display cap from the recovery selector.
  ///
  /// Persists through the existing party-scoped `SettingsPort` string key
  /// ([CctvWallSettingsKeys.cameraCount]) without extending its interface.
  /// Added cameras mount fresh tiles; removed cameras unmount (their
  /// decoders dispose) while shared cameras keep their elements, decoders,
  /// and focus nodes by stable cameraId keys and indices.
  Future<void> _selectCameraCount(int count) async {
    if (!isSupportedCctvClipCount(count) || count == _cameraCount) {
      return;
    }
    final int previous = _cameraCount;
    _cameraCount = count;
    late final Map<String, TileMediaSource> nextSources;
    try {
      nextSources = _activeSources(_sourcesFor(_manifest, _mediaByClipId));
    } on Object {
      _cameraCount = previous;
      if (mounted) {
        setState(() {
          _recoveryStatus = 'Camera layout could not be activated.';
        });
      }
      return;
    }
    if (!mounted) {
      _cameraCount = previous;
      return;
    }
    setState(() {
      _wallGeneration++;
      _tileSources = nextSources;
      _reconcileLayout();
    });
    final SettingsPort? settings = widget.settings;
    if (settings != null) {
      unawaited(
        settings.setString(
          partyId: PartyId(widget.partyId),
          key: CctvWallSettingsKeys.cameraCount,
          value: '$count',
        ),
      );
    }
  }

  /// Toggles the decoder-preserving camera hero for the focused tile.
  ///
  /// Opening animates the selected EXISTING tile to the viewport rectangle
  /// and fades its siblings; every CameraTile stays mounted, so no decoder
  /// is created or disposed during the zoom.
  void _toggleHero() {
    if (_heroCameraId != null) {
      _closeHero();
      return;
    }
    final List<String> active = _activeCameraIds();
    if (active.isEmpty) {
      return;
    }
    int index = _focus.focusedIndex;
    if (index < 0 || index >= active.length) {
      index = 0;
    }
    setState(() {
      _heroCameraId = active[index];
      _heroOriginIndex = index;
    });
  }

  /// Exits the hero and restores the originating focus.
  void _closeHero() {
    if (_heroCameraId == null) {
      return;
    }
    final int origin = _heroOriginIndex;
    setState(() {
      _heroCameraId = null;
    });
    // Restore the ORIGIN explicitly (not just "current focus"): nothing
    // traverses in hero, but this guards against any stale focus index.
    _focus.markFocused(origin);
    _restoreTileFocus();
  }

  Future<void> _retryCached() async {
    final Future<VerifiedWallPlayback?> Function()? retryPlayback =
        widget.onRetryCachedPlayback;
    // A count change or newer activation supersedes this retry: its failure
    // UI must not clobber the newer wall state.
    final int generation = _wallGeneration;
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
          if (mounted && generation == _wallGeneration) {
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
      if (mounted && generation == _wallGeneration) {
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

  bool _isBackKey(LogicalKeyboardKey key) =>
      key == LogicalKeyboardKey.backspace ||
      key == LogicalKeyboardKey.goBack ||
      key == LogicalKeyboardKey.escape ||
      key == LogicalKeyboardKey.gameButtonB;

  KeyEventResult _onWallKey(FocusNode node, KeyEvent event) {
    // Short release of select/enter/gameButtonA opens the hero; BACK keys
    // (backspace/escape/gameButtonB) restore the grid and originating focus.
    // A held select opens recovery once (deferred panel focus keeps its
    // release from triggering the hero or a recovery action). Held-select
    // repeats are swallowed so they can never retrigger the hero; arrow
    // repeats keep flowing to traversal so a held D-pad direction moves
    // across tiles. Grid traversal is suppressed in hero, and hero stays
    // available when recovery is disabled.
    if (event is KeyRepeatEvent) {
      if (_isSelectKey(event.logicalKey)) {
        return KeyEventResult.handled;
      }
      if (_heroCameraId != null ||
          _recoveryVisible ||
          _guestCodesVisible ||
          _hostCodesVisible) {
        return KeyEventResult.handled;
      }
      if (_focus.handleArrow(event.logicalKey)) {
        return KeyEventResult.handled;
      }
      return KeyEventResult.ignored;
    }
    if (event is KeyDownEvent) {
      if (event.logicalKey == LogicalKeyboardKey.contextMenu ||
          event.logicalKey == LogicalKeyboardKey.gameButtonStart) {
        if (widget.recoveryEnabled) {
          _openRecovery();
        }
        return KeyEventResult.handled;
      }
      if (_isBackKey(event.logicalKey)) {
        if (_recoveryVisible || _guestCodesVisible || _hostCodesVisible) {
          // A panel owns BACK semantics once visible; tile-side input is
          // vestigial until the held key (if any) is released.
          return KeyEventResult.handled;
        }
        if (_heroCameraId != null) {
          _closeHero();
          return KeyEventResult.handled;
        }
        return KeyEventResult.ignored;
      }
      if (_isSelectKey(event.logicalKey)) {
        if (!_selectHeld) {
          _selectHeld = true;
          _selectDownAt = widget.clock.now();
          _holdFired = false;
          if (widget.recoveryEnabled) {
            _okHoldTimer?.cancel();
            _okHoldTimer = Timer(widget.longPressDuration, () {
              _okHoldTimer = null;
              if (!mounted) {
                return;
              }
              _holdFired = true;
              final bool wasVisible = _recoveryVisible;
              _openRecovery(deferFocus: true);
              if (_recoveryVisible && !wasVisible) {
                _awaitingSelectRelease = true;
              }
            });
          }
        }
        return KeyEventResult.handled;
      }
      if (_heroCameraId != null ||
          _recoveryVisible ||
          _guestCodesVisible ||
          _hostCodesVisible) {
        return KeyEventResult.handled;
      }
      if (_focus.handleArrow(event.logicalKey)) {
        return KeyEventResult.handled;
      }
      return KeyEventResult.ignored;
    }
    if (event is KeyUpEvent && _isSelectKey(event.logicalKey)) {
      _selectHeld = false;
      _okHoldTimer?.cancel();
      _okHoldTimer = null;
      if (!mounted) {
        return KeyEventResult.handled;
      }
      if (_awaitingSelectRelease) {
        // Held select that opened recovery: the release focuses the panel
        // and can never trigger the hero or a recovery action.
        _awaitingSelectRelease = false;
        _holdFired = false;
        _selectDownAt = null;
        if (_recoveryVisible) {
          _recoveryFocus.requestFocus();
        }
        return KeyEventResult.handled;
      }
      if (_holdFired) {
        _holdFired = false;
        _selectDownAt = null;
        return KeyEventResult.handled;
      }
      if (_recoveryVisible || _guestCodesVisible || _hostCodesVisible) {
        _selectDownAt = null;
        return KeyEventResult.handled;
      }
      final DateTime? downAt = _selectDownAt;
      _selectDownAt = null;
      // Held past the long-press threshold without recovery (disabled):
      // a held select is never a hero open.
      if (downAt != null &&
          widget.clock.now().difference(downAt) >= widget.longPressDuration) {
        return KeyEventResult.handled;
      }
      _toggleHero();
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
      // discarding the registry object. The camera count is the EFFECTIVE
      // display cap (`min(configured, manifest clips)`); the hero target is
      // transient UI state, never persisted.
      settings: ChannelSettings(<String, Object?>{
        CctvWallSettingsKeys.effectsDisabled: _effectsDisabled,
        CctvWallSettingsKeys.manifestVersion: _manifest.version,
        CctvWallSettingsKeys.overscanSafe: true,
        CctvWallSettingsKeys.cameraCount: '$_effectiveCount',
        if (_heroCameraId != null)
          CctvWallSettingsKeys.heroCameraId: _heroCameraId!,
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
                  // An unsupported boot manifest never reaches the tile
                  // builders (their sources cannot exist): the SIGNAL-LOST
                  // frame stays until a supported wall activates. The frame
                  // is wrapped in an autofocus node so wall keys (MENU,
                  // BACK) keep bubbling to the gate above even with no
                  // tiles mounted.
                  child: _manifestSupported
                      ? channel.build(channelContext)
                      : Focus(
                          autofocus: true,
                          onKeyEvent: (FocusNode node, KeyEvent event) =>
                              KeyEventResult.ignored,
                          child: const SignalLost(
                            key: ValueKey<String>('wall-unsupported-manifest'),
                          ),
                        ),
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
                        client: widget.guestCodeClient!,
                        tvDeviceId: widget.tvDeviceId,
                        primaryFocusNode: _recoveryFocus,
                        onBack: _closeGuestCodes,
                        onClose: _closeRecovery,
                      )
                    : _hostCodesVisible
                    ? HostCodePanel(
                        client: widget.hostInviteClient!,
                        devicesClient: widget.hostDeviceClient,
                        primaryFocusNode: _recoveryFocus,
                        onBack: _closeHostCodes,
                        onClose: _closeRecovery,
                      )
                    : RecoveryOverlay(
                        effectsDisabled: _effectsDisabled,
                        statusMessage: _recoveryStatus,
                        primaryFocusNode: _recoveryFocus,
                        onRetryCached: () => unawaited(_retryCached()),
                        onToggleEffects: _toggleEffects,
                        onClose: _closeRecovery,
                        cameraCount: _cameraCount,
                        onSelectCameraCount: _selectCameraCount,
                        onShowGuestCodes: widget.guestCodeClient == null
                            ? null
                            : _openGuestCodes,
                        onShowHostCodes: widget.hostInviteClient == null
                            ? null
                            : _openHostCodes,
                      ),
              ),
            ),
        ],
      ),
    );
  }
}
