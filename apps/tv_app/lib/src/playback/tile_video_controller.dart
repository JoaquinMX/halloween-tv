/// Per-tile video controller seam (Technical Design v1.0, section 13).
///
/// The app layer — not the channel — owns one `VideoPlayerController` per
/// wall tile. This interface is the narrow slice of that controller the
/// tile widget needs, so tests can drive real tile behaviour (init, looping,
/// muted autoplay, async failures) without a platform decoder.
library;

import 'package:flutter/widgets.dart';

/// Concrete, already-verified source for one tile. Signed network URLs never
/// cross into video_player; live playback always resolves to a local file.
sealed class TileMediaSource {
  const TileMediaSource();

  String get reference;

  @override
  bool operator ==(Object other) =>
      other.runtimeType == runtimeType &&
      other is TileMediaSource &&
      other.reference == reference;

  @override
  int get hashCode => Object.hash(runtimeType, reference);
}

/// A bundled, byte-verified fixture asset.
final class BundledAssetSource extends TileMediaSource {
  const BundledAssetSource(this.assetPath);
  final String assetPath;
  @override
  String get reference => assetPath;
}

/// A locally cached file whose hash was verified by the cache pipeline.
final class LocalFileSource extends TileMediaSource {
  const LocalFileSource(this.path);
  final String path;
  @override
  String get reference => path;
}

/// Controller owned by a single [CameraTile].
abstract class TileVideoController {
  /// Prepares the decoder. May throw when the clip is missing/corrupt.
  Future<void> initialize();

  /// Whether [initialize] completed successfully.
  bool get isInitialized;

  /// Whether the controller reported a playback error.
  bool get hasError;

  /// Human-readable error, when [hasError] is true.
  String? get errorDescription;

  /// Video surface for this tile (already sized/covered by the caller).
  Widget buildSurface(BuildContext context);

  /// Loop playback (the wall loops every clip).
  Future<void> setLooping(bool looping);

  /// Volume in `0..1`; the wall is always muted (`0`).
  Future<void> setVolume(double volume);

  /// Start playback.
  Future<void> play();

  /// Registers a change listener (exposed so the tile can react to async
  /// decoder errors that arrive after initialization).
  void addListener(VoidCallback listener);

  /// Removes a previously added listener.
  void removeListener(VoidCallback listener);

  /// Releases the decoder. Called exactly once by the owning tile.
  Future<void> dispose();
}

/// Builds a [TileVideoController] for one wall tile.
///
/// Injected so widget tests can substitute a fake decoder while the tile,
/// wall chrome, focus handling and error fallback stay on their real paths.
typedef TileVideoControllerFactory =
    TileVideoController Function({
      required String cameraId,
      required TileMediaSource source,
    });
