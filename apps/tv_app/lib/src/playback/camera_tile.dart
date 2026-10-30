/// One wall tile: owns its video controller, handles failure, D-pad focus,
/// and controlled source replacement.
library;

import 'dart:async';

import 'package:core_ui/core_ui.dart';
import 'package:flutter/material.dart';

import 'package:tv_app/src/playback/tile_video_controller.dart';

class CameraTile extends StatefulWidget {
  const CameraTile({
    super.key,
    required this.index,
    required this.cameraId,
    required this.source,
    required this.focusNode,
    required this.controllerFactory,
    this.onFocusChange,
    this.onSourceSettled,
    this.onInitialSettled,
    this.autofocus = false,
  });

  final int index;
  final String cameraId;
  final TileMediaSource source;
  final FocusNode focusNode;
  final TileVideoControllerFactory controllerFactory;
  final ValueChanged<bool>? onFocusChange;
  final ValueChanged<bool>? onSourceSettled;
  final VoidCallback? onInitialSettled;
  final bool autofocus;

  @override
  State<CameraTile> createState() => _CameraTileState();
}

class _CameraTileState extends State<CameraTile> {
  TileVideoController? _controller;
  late TileMediaSource _activeSource;
  int _generation = 0;
  bool _initialized = false;
  bool _failed = false;
  bool _replacing = false;
  bool _focused = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _activeSource = widget.source;
    final TileVideoController controller = _create(widget.source);
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
    if (widget.source != _activeSource) {
      unawaited(_replaceSource(widget.source));
    }
  }

  TileVideoController _create(TileMediaSource source) =>
      widget.controllerFactory(cameraId: widget.cameraId, source: source);

  Future<void> _replaceSource(TileMediaSource target) async {
    final int generation = ++_generation;
    final TileMediaSource previous = _activeSource;
    final TileVideoController? old = _controller;
    _controller = null;
    if (mounted) {
      setState(() {
        _initialized = false;
        _failed = false;
        _replacing = true;
        _error = null;
      });
    }
    await _disposeController(old);
    if (!mounted || generation != _generation) return;

    final TileVideoController replacement = _create(target);
    _controller = replacement;
    replacement.addListener(_onControllerUpdate);
    if (await _configure(replacement, generation)) {
      if (!mounted || generation != _generation) return;
      _activeSource = target;
      setState(() {
        _initialized = true;
        _failed = false;
        _replacing = false;
      });
      widget.onSourceSettled?.call(true);
      return;
    }

    if (!mounted || generation != _generation) return;
    final TileVideoController? failed = _controller;
    _controller = null;
    await _disposeController(failed);
    if (!mounted || generation != _generation) return;

    // One tile at a time is replaced, and the old source is recreated if the
    // new decoder fails. This stays within four decoders and keeps the other
    // wall slots running while this slot rolls back.
    final TileVideoController rollback = _create(previous);
    _controller = rollback;
    rollback.addListener(_onControllerUpdate);
    final bool restored = await _configure(rollback, generation);
    if (!mounted || generation != _generation) return;
    setState(() {
      _activeSource = previous;
      _initialized = restored;
      _failed = !restored;
      _replacing = false;
      _error = restored ? null : 'replacement and rollback failed';
    });
    widget.onSourceSettled?.call(false);
  }

  Future<bool> _configure(
    TileVideoController controller,
    int generation,
  ) async {
    try {
      await controller.initialize();
      if (!mounted || generation != _generation) return false;
      await controller.setLooping(true);
      await controller.setVolume(0);
      await controller.play();
      return mounted && generation == _generation && !controller.hasError;
    } on Object catch (error) {
      if (mounted && generation == _generation) _error = error.toString();
      return false;
    }
  }

  Future<void> _start(TileVideoController controller, int generation) async {
    final bool success = await _configure(controller, generation);
    if (!mounted || generation != _generation) return;
    setState(() {
      _initialized = success;
      _failed = !success;
      _error ??= controller.errorDescription;
    });
    widget.onInitialSettled?.call();
  }

  void _onControllerUpdate() {
    if (!mounted || _failed) return;
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
    controller?.removeListener(_onControllerUpdate);
    unawaited(_disposeController(controller));
    super.dispose();
  }

  Future<void> _disposeController(TileVideoController? controller) async {
    if (controller == null) return;
    controller.removeListener(_onControllerUpdate);
    try {
      await controller.dispose();
    } on Object {
      // A platform teardown failure must not strand a replacement.
    }
  }

  Widget _surface(BuildContext context) {
    if (_failed) {
      return SignalLost(
        key: ValueKey<String>('signal-lost-${widget.cameraId}'),
      );
    }
    final TileVideoController? controller = _controller;
    if (!_initialized || _replacing || controller == null) {
      return const _ConnectingFeed();
    }
    return controller.buildSurface(context);
  }

  @override
  Widget build(BuildContext context) => Focus(
    focusNode: widget.focusNode,
    debugLabel: 'wall-tile-${widget.index}',
    onFocusChange: (bool focused) {
      setState(() => _focused = focused);
      widget.onFocusChange?.call(focused);
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

class _ConnectingFeed extends StatelessWidget {
  const _ConnectingFeed();

  @override
  Widget build(BuildContext context) => const ColoredBox(
    color: Color(0xFF050505),
    child: Center(child: Text('CONNECTING…', style: CctvTheme.badgeStyle)),
  );
}
