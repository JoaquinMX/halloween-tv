/// Test doubles for the app's own ports (never for sibling contracts).
library;

import 'package:core_playlist/core_playlist.dart';
import 'package:flutter/widgets.dart';
import 'package:tv_app/src/playback/tile_video_controller.dart';
import 'package:tv_app/src/wall/manifest_store.dart';

/// In-memory [WallManifestStore].
final class InMemoryManifestStore implements WallManifestStore {
  InMemoryManifestStore([this.stored]);

  /// Currently stored manifest.
  PlaybackManifest? stored;

  /// Number of [read] calls.
  int reads = 0;

  /// Number of [write] calls.
  int writes = 0;

  /// When true, [read] throws (simulates a broken platform channel).
  bool failReads = false;

  @override
  Future<PlaybackManifest?> read() async {
    reads++;
    if (failReads) {
      throw StateError('prefs unavailable');
    }
    return stored;
  }

  @override
  Future<void> write(PlaybackManifest manifest) async {
    writes++;
    stored = manifest;
  }
}

/// Fake decoder standing in for `VideoPlayerController`.
///
/// Records the lifecycle the tile is expected to drive (loop/mute/play) and
/// can fail during initialize or emit a late error, which is exactly what a
/// TV decoder does with a missing or corrupt clip.
final class FakeTileVideoController implements TileVideoController {
  FakeTileVideoController({
    required this.cameraId,
    required this.source,
    this.failOnInitialize = false,
    this.lateErrorOnInitialize = false,
  });

  /// Camera this fake serves.
  final String cameraId;

  /// Asset the tile asked for.
  final TileMediaSource source;
  String get assetPath => source.reference;

  /// Throws from [initialize].
  final bool failOnInitialize;

  /// Succeeds, then flips [hasError] on the next listener notification.
  final bool lateErrorOnInitialize;

  /// Whether [setLooping] was called with true.
  bool looping = false;

  /// Last volume set.
  double volume = 1;

  /// Whether [play] was called.
  bool playing = false;

  /// Whether [dispose] was called.
  bool disposed = false;

  /// Ordered lifecycle calls, for assertions.
  final List<String> calls = <String>[];

  final List<VoidCallback> _listeners = <VoidCallback>[];
  bool _initialized = false;
  bool _hasError = false;
  String? _error;

  @override
  Future<void> initialize() async {
    calls.add('initialize');
    if (failOnInitialize) {
      throw StateError('decoder failed for $cameraId');
    }
    _initialized = true;
    if (lateErrorOnInitialize) {
      _hasError = true;
      _error = 'late decoder error';
    }
  }

  /// Simulates a decoder error arriving after playback started.
  void emitError([String message = 'stream corrupted']) {
    _hasError = true;
    _error = message;
    for (final VoidCallback listener in List<VoidCallback>.of(_listeners)) {
      listener();
    }
  }

  @override
  bool get isInitialized => _initialized;

  @override
  bool get hasError => _hasError;

  @override
  String? get errorDescription => _error;

  @override
  Widget buildSurface(BuildContext context) => ColoredBox(
    key: ValueKey<String>('video-surface-$cameraId'),
    color: const Color(0xFF10241A),
    child: Center(child: Text('LIVE $cameraId')),
  );

  @override
  Future<void> setLooping(bool value) async {
    calls.add('setLooping($value)');
    looping = value;
  }

  @override
  Future<void> setVolume(double value) async {
    calls.add('setVolume($value)');
    volume = value;
  }

  @override
  Future<void> play() async {
    calls.add('play');
    playing = true;
  }

  @override
  void addListener(VoidCallback listener) => _listeners.add(listener);

  @override
  void removeListener(VoidCallback listener) => _listeners.remove(listener);

  @override
  Future<void> dispose() async {
    calls.add('dispose');
    disposed = true;
    _listeners.clear();
  }
}

/// Factory producing [FakeTileVideoController]s, optionally failing some.
TileVideoControllerFactory fakeControllerFactory({
  Set<String> failing = const <String>{},
  Set<String> lateError = const <String>{},
  Map<String, FakeTileVideoController>? sink,
}) {
  return ({required String cameraId, required TileMediaSource source}) {
    final FakeTileVideoController controller = FakeTileVideoController(
      cameraId: cameraId,
      source: source,
      failOnInitialize: failing.contains(cameraId),
      lateErrorOnInitialize: lateError.contains(cameraId),
    );
    sink?[cameraId] = controller;
    return controller;
  };
}
