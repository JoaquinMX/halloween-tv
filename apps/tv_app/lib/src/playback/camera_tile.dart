/// One wall tile: owns its video controller, handles failure, D-pad focus.
library;

import 'dart:async';

import 'package:core_ui/core_ui.dart';
import 'package:flutter/material.dart';

import 'tile_video_controller.dart';

/// Wall slot showing a single camera feed.
///
/// Lifecycle ownership (design s13): this widget creates exactly one
/// [TileVideoController] for its [cameraId], initializes it, forces looping,
/// mutes it, starts playback, and disposes it. When initialization or
/// playback fails the tile renders [SignalLost] instead of the surface —
/// the other three tiles keep playing.
class CameraTile extends StatefulWidget {
  /// Creates a tile for wall [index].
  const CameraTile({
    super.key,
    required this.index,
    required this.cameraId,
    required this.assetPath,
    required this.focusNode,
    required this.controllerFactory,
    this.onFocusChange,
    this.autofocus = false,
  });

  /// Wall slot index (`0..3`).
  final int index;

  /// Camera id, e.g. `CAM-01`.
  final String cameraId;

  /// Bundled clip path (see [kCameraAssetPaths]).
  final String assetPath;

  /// Focus node owned by the wall's D-pad controller.
  final FocusNode focusNode;

  /// Builds the decoder for this tile.
  final TileVideoControllerFactory controllerFactory;

  /// Reports focus changes back to the wall (focus ring + traversal state).
  final ValueChanged<bool>? onFocusChange;

  /// Whether this tile requests focus once it is mounted.
  final bool autofocus;

  @override
  State<CameraTile> createState() => _CameraTileState();
}

class _CameraTileState extends State<CameraTile> {
  TileVideoController? _controller;
  int _generation = 0;
  bool _initialized = false;
  bool _failed = false;
  String? _error;
  bool _focused = false;

  @override
  void initState() {
    super.initState();
    final TileVideoController controller = widget.controllerFactory(
      cameraId: widget.cameraId,
      assetPath: widget.assetPath,
    );
    _controller = controller;
    controller.addListener(_onControllerUpdate);
    unawaited(_start(controller, _generation));
    if (widget.autofocus) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && widget.focusNode.context != null) {
          widget.focusNode.requestFocus();
        }
      });
    }
  }

  @override
  void didUpdateWidget(CameraTile oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Asset swap for a reconfigured slot (same stable tile key, new camera
    // feed): dispose-before-create keeps the decoder budget at one live
    // controller per tile (four wall-wide) instead of transiently doubling.
    if (oldWidget.cameraId != widget.cameraId ||
        oldWidget.assetPath != widget.assetPath) {
      _swapController();
    }
  }

  /// Releases the old decoder before allocating its replacement.
  Future<void> _swapController() async {
    final int generation = ++_generation;
    final TileVideoController? old = _controller;
    _controller = null;
    setState(() {
      _initialized = false;
      _failed = false;
      _error = null;
    });
    if (old != null) {
      old.removeListener(_onControllerUpdate);
      try {
        await old.dispose();
      } catch (_) {
        // A failing teardown must not block the replacement feed.
      }
    }
    if (!mounted || generation != _generation) {
      return;
    }
    final TileVideoController next = widget.controllerFactory(
      cameraId: widget.cameraId,
      assetPath: widget.assetPath,
    );
    _controller = next;
    next.addListener(_onControllerUpdate);
    await _start(next, generation);
  }
  /// Initialize -> loop -> mute -> autoplay. Every step is guarded: a
  /// decoder/platform failure marks this tile lost but never rethrows.
  /// [generation] guards against a stale async start after a swap/dispose.
  Future<void> _start(TileVideoController controller, int generation) async {
    try {
      await controller.initialize();
      if (!mounted || generation != _generation) {
        return;
      }
      await controller.setLooping(true);
      await controller.setVolume(0);
      await controller.play();
      if (!mounted || generation != _generation) {
        return;
      }
      setState(() => _initialized = true);
    } catch (error) {
      if (!mounted || generation != _generation) {
        return;
      }
      setState(() {
        _failed = true;
        _error = error.toString();
      });
    }
  }

  /// Decoder errors can also arrive after a successful initialize().
  void _onControllerUpdate() {
    if (!mounted || _failed) {
      return;
    }
    final TileVideoController? controller = _controller;
    if (controller != null && controller.hasError) {
      setState(() {
        _failed = true;
        _error = controller.errorDescription ?? 'playback error';
      });
    }
  }

  @override
  void dispose() {
    _generation++;
    final TileVideoController? controller = _controller;
    _controller = null;
    if (controller != null) {
      controller.removeListener(_onControllerUpdate);
      // Never let a teardown failure escape dispose (would crash the wall);
      // the decoder is released best-effort.
      unawaited(_disposeQuietly(controller));
    }
    super.dispose();
  }

  /// Best-effort controller teardown that swallows decoder errors.
  static Future<void> _disposeQuietly(TileVideoController controller) async {
    try {
      await controller.dispose();
    } catch (_) {
      // Intentionally ignored: dispose must never throw.
    }
  }

  Widget _surface(BuildContext context) {
    if (_failed) {
      return SignalLost(
        key: ValueKey<String>('signal-lost-${widget.cameraId}'),
      );
    }
    final TileVideoController? controller = _controller;
    if (!_initialized || controller == null) {
      return const _ConnectingFeed();
    }
    return controller.buildSurface(context);
  }

  @override
  Widget build(BuildContext context) {
    return Focus(
      focusNode: widget.focusNode,
      debugLabel: 'wall-tile-${widget.index}',
      onFocusChange: (bool hasFocus) {
        setState(() => _focused = hasFocus);
        widget.onFocusChange?.call(hasFocus);
      },
      child: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          _surface(context),
          if (_focused)
            DecoratedBox(
              key: ValueKey<String>('tile-focus-ring-${widget.index}'),
              decoration: BoxDecoration(
                border: Border.all(color: const Color(0xFFB8FFB8), width: 3),
              ),
              child: const SizedBox.expand(),
            ),
          if (_failed)
            Semantics(
              label: '${widget.cameraId} feed lost: ${_error ?? 'unknown'}',
              child: const SizedBox.expand(),
            ),
        ],
      ),
    );
  }
}

/// Pre-first-frame placeholder; deliberately dark and quiet.
class _ConnectingFeed extends StatelessWidget {
  const _ConnectingFeed();

  @override
  Widget build(BuildContext context) {
    return const ColoredBox(
      color: Color(0xFF050505),
      child: Center(
        child: Text('CONNECTING…', style: CctvTheme.badgeStyle),
      ),
    );
  }
}
