/// Host video preview: fresh scoped capability per view + playback.
///
/// The screen requests a new preview capability on open
/// ([HostSession.preview] → `getHostVideoPreview`): signed URLs are
/// short-lived and never persisted, so a cached capability is never reused.
/// Tapping a camera creates its player; switching cameras or leaving the
/// screen disposes the previous player. Backgrounding pauses playback
/// (the app observer additionally suspends catalog polling while the
/// capability itself simply expires server-side).
///
/// The [playerFactory] seam substitutes ONLY the platform player boundary
/// (the shipped default builds a real [VideoPlayerController]); everything
/// above it — capability fetch, validation, play/dispose lifecycle — is the
/// real production path.
library;

import 'package:companion_app/src/data/host_media_client.dart';
import 'package:companion_app/src/session/host_session.dart';
import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

/// Platform player boundary for host previews.
abstract interface class HostPreviewPlayer {
  Future<void> initialize();
  Future<void> play();
  Future<void> pause();
  Future<void> dispose();
  bool get isInitialized;
  double get aspectRatio;
  Widget buildView();
}

final class _VideoPreviewPlayer implements HostPreviewPlayer {
  _VideoPreviewPlayer(Uri url)
    : _controller = VideoPlayerController.networkUrl(url);

  final VideoPlayerController _controller;

  @override
  Future<void> initialize() => _controller.initialize();

  @override
  Future<void> play() => _controller.play();

  @override
  Future<void> pause() => _controller.pause();

  @override
  Future<void> dispose() => _controller.dispose();

  @override
  bool get isInitialized => _controller.value.isInitialized;

  @override
  double get aspectRatio => _controller.value.aspectRatio;

  @override
  Widget buildView() => VideoPlayer(_controller);
}

final class HostVideoPreviewScreen extends StatefulWidget {
  const HostVideoPreviewScreen({
    super.key,
    required this.session,
    required this.seedId,
    this.playerFactory = _VideoPreviewPlayer.new,
  });

  final HostSession session;
  final String seedId;

  /// Substitutes only the platform player boundary.
  final HostPreviewPlayer Function(Uri url) playerFactory;

  static const Key statusKey = Key('host-preview-status');
  static const Key errorKey = Key('host-preview-error');
  static const Key videoKey = Key('host-preview-video');
  static Key playKey(String cameraId) => Key('host-preview-play-$cameraId');

  @override
  State<HostVideoPreviewScreen> createState() => _HostVideoPreviewScreenState();
}

final class _HostVideoPreviewScreenState extends State<HostVideoPreviewScreen>
    with WidgetsBindingObserver {
  late final Future<HostVideoPreview> _capability;
  HostPreviewPlayer? _player;
  String? _activeCamera;
  String? _playError;
  bool _initializing = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Fresh scoped capability per view: never reuse a cached preview.
    _capability = widget.session.preview(widget.seedId);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused) {
      _player?.pause();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _disposePlayer();
    super.dispose();
  }

  void _disposePlayer() {
    final HostPreviewPlayer? player = _player;
    _player = null;
    _activeCamera = null;
    if (player != null) {
      player.pause();
      player.dispose();
    }
  }

  Future<void> _play(HostVideoPreviewClip clip) async {
    if (_initializing || _activeCamera == clip.cameraId) return;
    setState(() {
      _initializing = true;
      _playError = null;
    });
    _disposePlayer();
    final HostPreviewPlayer player = widget.playerFactory(clip.url);
    try {
      await player.initialize();
      if (!mounted) {
        await player.dispose();
        return;
      }
      setState(() {
        _player = player;
        _activeCamera = clip.cameraId;
      });
      await player.play();
    } on Object catch (error) {
      await player.dispose();
      if (mounted) {
        setState(() => _playError = 'Could not play ${clip.cameraId}');
        // Keep the raw platform detail out of the UI; it stays in debug
        // logs only.
        debugPrint('Host preview playback failed: $error');
      }
    } finally {
      if (mounted) setState(() => _initializing = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text('Preview ${widget.seedId}')),
    body: Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: FutureBuilder<HostVideoPreview>(
            future: _capability,
            builder: (context, snapshot) {
              if (snapshot.connectionState != ConnectionState.done) {
                return const Center(
                  key: HostVideoPreviewScreen.statusKey,
                  child: CircularProgressIndicator(),
                );
              }
              if (snapshot.hasError) {
                return Text(
                  '${snapshot.error}',
                  key: HostVideoPreviewScreen.errorKey,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                );
              }
              final HostVideoPreview preview = snapshot.data!;
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  if (_player != null && _player!.isInitialized) ...<Widget>[
                    AspectRatio(
                      key: HostVideoPreviewScreen.videoKey,
                      aspectRatio: _player!.aspectRatio,
                      child: _player!.buildView(),
                    ),
                    const SizedBox(height: 12),
                  ],
                  if (_playError != null)
                    Text(
                      _playError!,
                      key: HostVideoPreviewScreen.errorKey,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ...preview.clips.map(
                    (clip) => Card(
                      key: Key('host-preview-clip-${clip.cameraId}'),
                      margin: const EdgeInsets.symmetric(vertical: 6),
                      child: ListTile(
                        title: Text(
                          clip.cameraId,
                          style: const TextStyle(fontSize: 20),
                        ),
                        subtitle: const Text('Signed preview (short-lived)'),
                        trailing: _initializing && _activeCamera == null
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : TextButton(
                                key: HostVideoPreviewScreen.playKey(
                                  clip.cameraId,
                                ),
                                onPressed: () => _play(clip),
                                child: Text(
                                  _activeCamera == clip.cameraId
                                      ? 'Playing'
                                      : 'Play',
                                ),
                              ),
                      ),
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    ),
  );
}
