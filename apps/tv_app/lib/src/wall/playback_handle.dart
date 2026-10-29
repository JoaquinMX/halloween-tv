/// App-owned playback control surface handed to the channel.
library;

import 'package:channel_api/channel_api.dart';

/// [PlaybackHandle] the app hands to the CCTV channel.
///
/// The channel asks the app to `prepare` (decoders may start) and
/// `activate` (wall is visible). The app owns the concrete players per tile,
/// so both steps only flip state here; call counts are observable for
/// diagnostics and tests.
final class WallPlaybackHandle implements PlaybackHandle {
  bool _prepared = false;
  bool _activated = false;

  /// Whether the channel called [prepare].
  bool get isPrepared => _prepared;

  /// Whether the channel called [activate].
  bool get isActivated => _activated;

  /// Number of [prepare] calls.
  int prepareCalls = 0;

  /// Number of [activate] calls.
  int activateCalls = 0;

  @override
  Future<void> prepare() async {
    prepareCalls++;
    _prepared = true;
  }

  @override
  Future<void> activate() async {
    activateCalls++;
    _activated = true;
  }
}
