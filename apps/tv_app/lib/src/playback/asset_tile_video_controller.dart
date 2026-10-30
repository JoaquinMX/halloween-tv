/// `video_player`-backed [TileVideoController] for bundled fixture clips.
library;

import 'package:flutter/widgets.dart';
import 'package:video_player/video_player.dart';

import 'package:tv_app/src/playback/file_tile_video_controller.dart';
import 'package:tv_app/src/playback/tile_video_controller.dart';

/// Real decoder-backed tile controller (one per wall tile).
///
/// Owns a [VideoPlayerController] for a bundled asset. The owning
/// [CameraTile] calls [initialize], then [setLooping] + [setVolume] +
/// [play]; [dispose] releases the decoder exactly once.
final class AssetTileVideoController implements TileVideoController {
  /// Creates a controller for [assetPath] (a camera fixture clip).
  AssetTileVideoController({
    required this.cameraId,
    required String assetPath,
    VideoPlayerController? controller,
  }) : _controller =
           controller ??
           VideoPlayerController.asset(
             assetPath,
             // Android TV: mix with others keeps volume handling boring;
             // the wall is muted anyway (volume 0).
             videoPlayerOptions: VideoPlayerOptions(mixWithOthers: true),
           );

  /// Camera this tile belongs to (diagnostics only).
  final String cameraId;

  final VideoPlayerController _controller;
  bool _disposed = false;

  @override
  Future<void> initialize() => _controller.initialize();

  @override
  bool get isInitialized => _controller.value.isInitialized;

  @override
  bool get hasError => _controller.value.hasError;

  @override
  String? get errorDescription => _controller.value.errorDescription;

  @override
  Future<void> setLooping(bool looping) => _controller.setLooping(looping);

  @override
  Future<void> setVolume(double volume) => _controller.setVolume(volume);

  @override
  Future<void> play() => _controller.play();

  @override
  void addListener(VoidCallback listener) => _controller.addListener(listener);

  @override
  void removeListener(VoidCallback listener) =>
      _controller.removeListener(listener);

  @override
  Future<void> dispose() async {
    if (_disposed) {
      return;
    }
    _disposed = true;
    await _controller.dispose();
  }

  @override
  Widget buildSurface(BuildContext context) {
    final Size size = _controller.value.size;
    return ColoredBox(
      color: const Color(0xFF000000),
      child: SizedBox.expand(
        child: FittedBox(
          fit: BoxFit.cover,
          clipBehavior: Clip.hardEdge,
          child: SizedBox(
            width: size.width == 0 ? 960 : size.width,
            height: size.height == 0 ? 540 : size.height,
            child: VideoPlayer(_controller),
          ),
        ),
      ),
    );
  }
}

/// Factory for explicit bundled-asset and local-file inputs.
TileVideoController createTileVideoController({
  required String cameraId,
  required TileMediaSource source,
}) {
  return switch (source) {
    BundledAssetSource(:final assetPath) => AssetTileVideoController(
      cameraId: cameraId,
      assetPath: assetPath,
    ),
    LocalFileSource(:final path) => FileTileVideoController(
      cameraId: cameraId,
      path: path,
    ),
  };
}

/// Compatibility name retained for existing direct bundled-only callers.
TileVideoController createAssetTileVideoController({
  required String cameraId,
  required TileMediaSource source,
}) {
  if (source case BundledAssetSource(:final assetPath)) {
    return AssetTileVideoController(cameraId: cameraId, assetPath: assetPath);
  }
  throw ArgumentError.value(source, 'source', 'expected a bundled asset');
}
