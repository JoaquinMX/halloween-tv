/// `video_player` controller for verified cache files.
library;

import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:video_player/video_player.dart';

import 'package:tv_app/src/playback/tile_video_controller.dart';

/// Plays the app-private file named by [CachedMedia.localRef]. The source is
/// local by construction; remote delivery URLs are never handed to a decoder.
final class FileTileVideoController implements TileVideoController {
  FileTileVideoController({
    required this.cameraId,
    required String path,
    VideoPlayerController? controller,
  }) : path = path,
       _controller =
           controller ??
           VideoPlayerController.file(
             File(path),
             videoPlayerOptions: VideoPlayerOptions(mixWithOthers: true),
           );

  final String cameraId;
  final String path;
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
    if (_disposed) return;
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
