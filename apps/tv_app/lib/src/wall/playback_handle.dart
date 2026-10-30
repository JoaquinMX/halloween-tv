/// App-owned playback control surface handed to the channel.
library;

import 'package:kernel_app/kernel_app.dart';

/// Executes real source validation and wall activation actions for a staged
/// version. The channel calls prepare before rendering its tile surface.
final class WallPlaybackHandle implements PlaybackHandle {
  WallPlaybackHandle({
    Future<void> Function()? prepareAction,
    Future<void> Function()? activateAction,
  }) : _prepareAction = prepareAction,
       _activateAction = activateAction;

  final Future<void> Function()? _prepareAction;
  final Future<void> Function()? _activateAction;
  bool _prepared = false;
  bool _activated = false;

  bool get isPrepared => _prepared;
  bool get isActivated => _activated;
  int prepareCalls = 0;
  int activateCalls = 0;

  @override
  Future<void> prepare() async {
    prepareCalls++;
    await _prepareAction?.call();
    _prepared = true;
  }

  @override
  Future<void> activate() async {
    activateCalls++;
    if (!_prepared) {
      throw StateError('playback must be prepared before activation');
    }
    await _activateAction?.call();
    _activated = true;
  }
}
