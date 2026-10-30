/// Halloween TV app shell: boots the kernel, then hosts the wall.
library;

import 'package:core_foundation/core_foundation.dart';
import 'package:core_ui/core_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:tv_app/src/playback/asset_tile_video_controller.dart';
import 'package:tv_app/src/playback/tile_video_controller.dart';
import 'package:tv_app/src/wall/wall_boot.dart';
import 'package:tv_app/src/wall/wall_screen.dart';

/// Root widget: dark TV theme, no debug banner, wall as home.
class HalloweenTvApp extends StatelessWidget {
  /// Creates the app.
  const HalloweenTvApp({
    super.key,
    required this.boot,
    this.tileControllerFactory = createTileVideoController,
    this.clock = const SystemClock(),
  });

  /// Boot sequence producing the wall (or the reason there is none).
  final WallBoot boot;

  /// Decoder factory for the four tiles.
  final TileVideoControllerFactory tileControllerFactory;

  /// Clock for HUD timestamps.
  final Clock clock;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Halloween TV',
      debugShowCheckedModeBanner: false,
      theme: CctvTheme.dark(),
      home: WallGate(
        boot: boot,
        tileControllerFactory: tileControllerFactory,
        clock: clock,
      ),
    );
  }
}

/// Boots the wall and renders loading / unavailable / wall states.
class WallGate extends StatefulWidget {
  /// Creates the gate.
  const WallGate({
    super.key,
    required this.boot,
    required this.tileControllerFactory,
    required this.clock,
  });

  /// Boot sequence.
  final WallBoot boot;

  /// Decoder factory passed through to the wall.
  final TileVideoControllerFactory tileControllerFactory;

  /// Clock passed through to the wall.
  final Clock clock;

  @override
  State<WallGate> createState() => _WallGateState();
}

class _WallGateState extends State<WallGate> {
  late Future<WallBootResult> _bootFuture;

  @override
  void initState() {
    super.initState();
    _bootFuture = widget.boot.boot();
  }

  void _retryBoot() {
    setState(() {
      _bootFuture = widget.boot.boot();
    });
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<WallBootResult>(
      future: _bootFuture,
      builder: (BuildContext context, AsyncSnapshot<WallBootResult> snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const _WallLoading();
        }
        final WallBootResult? result = snapshot.data;
        if (result == null || !result.isReady) {
          final String reason =
              result?.unavailableReason ??
              snapshot.error?.toString() ??
              'unknown boot failure';
          return _WallUnavailable(reason: reason, onRetry: _retryBoot);
        }
        return WallScreen(
          plugin: result.plugin!,
          manifest: result.manifest!,
          partyId: widget.boot.partyId,
          tvDeviceId: widget.boot.tvDeviceId,
          guestCodeClient: widget.boot.guestCodeClient,
          clock: widget.clock,
          tileControllerFactory: widget.tileControllerFactory,
          onRetryCached: widget.boot.readCached,
          onRetryCachedPlayback: widget.boot.readCommittedPlayback,
          mediaByClipId: result.mediaByClipId,
          liveSession: result.liveSession,
          settings: result.settings,
          initialEffectsDisabled: result.initialEffectsDisabled,
        );
      },
    );
  }
}

/// Full-screen boot state.
class _WallLoading extends StatelessWidget {
  const _WallLoading();

  @override
  Widget build(BuildContext context) {
    return const ColoredBox(
      color: CctvTheme.gutter,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text('TUNING FEED…', style: CctvTheme.labelStyle),
            SizedBox(height: 16),
            SizedBox(
              width: 32,
              height: 32,
              child: CircularProgressIndicator(strokeWidth: 3),
            ),
          ],
        ),
      ),
    );
  }
}

/// No wall: app-level status + a D-pad reachable retry.
class _WallUnavailable extends StatelessWidget {
  const _WallUnavailable({required this.reason, required this.onRetry});

  final String reason;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: CctvTheme.gutter,
      child: SafeArea(
        minimum: const EdgeInsets.all(32),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 900),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const Text(
                  'NO WALL AVAILABLE',
                  style: CctvTheme.signalLostStyle,
                ),
                const SizedBox(height: 12),
                Text(
                  reason,
                  key: const ValueKey<String>('wall-unavailable-reason'),
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white70, fontSize: 20),
                ),
                const SizedBox(height: 24),
                FocusTraversalGroup(
                  child: OutlinedButton(
                    key: const ValueKey<String>('wall-retry'),
                    autofocus: true,
                    onPressed: onRetry,
                    style: OutlinedButton.styleFrom(
                      foregroundColor: Colors.white,
                      side: const BorderSide(
                        color: CctvTheme.frameEdge,
                        width: 2,
                      ),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 28,
                        vertical: 16,
                      ),
                    ),
                    child: const Text('RETRY', style: CctvTheme.badgeStyle),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Landscape-only TV orientation. Called once from `main`.
Future<void> lockLandscape() =>
    SystemChrome.setPreferredOrientations(const <DeviceOrientation>[
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
