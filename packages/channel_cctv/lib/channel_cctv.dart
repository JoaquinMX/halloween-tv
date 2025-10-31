import 'dart:async';

import 'package:channel_api/channel_api.dart';
import 'package:collection/collection.dart';
import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import 'package:core_ui/core_ui.dart';

class ChannelCctvPlugin implements ChannelPlugin {
  @override
  ChannelDescriptor get descriptor =>
      const ChannelDescriptor('surveillance.cctv', 'Haunted Surveillance', '1.0.0');

  @override
  Widget buildEntry(ChannelContext context) => CctvEntry(ctx: context);
}

class CctvEntry extends StatefulWidget {
  const CctvEntry({super.key, required this.ctx});

  final ChannelContext ctx;

  @override
  State<CctvEntry> createState() => _CctvEntryState();
}

class _CctvEntryState extends State<CctvEntry> {
  late final PreparePlaybackUseCase _useCase;
  late final Stream<PreparePlaybackState> _stateStream;
  late final Future<AppSettings> _settingsFuture;
  AppSettings? _settings;

  @override
  void initState() {
    super.initState();
    _useCase = PreparePlaybackUseCase(
      playlistPort: widget.ctx.playlistPort,
      cachePort: widget.ctx.cachePort,
      mediaFetchPort: widget.ctx.mediaFetchPort,
    );
    _stateStream = _useCase.execute(widget.ctx.partyId);
    _settingsFuture = widget.ctx.settingsPort.load();
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<AppSettings>(
      future: _settingsFuture,
      builder: (BuildContext context, AsyncSnapshot<AppSettings> snapshot) {
        if (snapshot.connectionState == ConnectionState.done && snapshot.hasData) {
          if (_settings != snapshot.data) {
            _settings = snapshot.data;
            widget.ctx.effectsEngine.toggle(_settings!.effectsEnabled);
          }
        }
        if (snapshot.hasError) {
          return _ErrorState(error: snapshot.error.toString());
        }
        if (!snapshot.hasData) {
          return const Center(child: CircularProgressIndicator());
        }
        return StreamBuilder<PreparePlaybackState>(
          stream: _stateStream,
          builder: (BuildContext context, AsyncSnapshot<PreparePlaybackState> stateSnapshot) {
            final PreparePlaybackState? state = stateSnapshot.data;
            if (state == null) {
              return const Center(child: CircularProgressIndicator());
            }
            if (state is PreparePlaybackLoading) {
              return const Center(child: CircularProgressIndicator());
            }
            if (state is PreparePlaybackReady) {
              final List<Widget> tiles = state.playlist.files
                  .mapIndexed(
                    (int index, PreparedClip clip) => _CctvTile(
                      key: ValueKey<String>(clip.item.localKey),
                      clip: clip,
                      timestampFormat: state.playlist.overlay.timestampFmt,
                      effectsEngine: widget.ctx.effectsEngine,
                      glitchIntensity: state.playlist.overlay.glitchIntensity,
                    ),
                  )
                  .toList(growable: false);
              return _CctvWall(tiles: tiles, isStale: state.isStale);
            }
            if (state is PreparePlaybackPartial) {
              final List<Widget> tiles = state.statuses.mapIndexed((int index, ClipLoadStatus status) {
                if (status.isReady) {
                  return _CctvTile(
                    key: ValueKey<String>(status.item.localKey),
                    clip: PreparedClip(item: status.item, file: status.file!),
                    timestampFormat: state.overlay.timestampFmt,
                    effectsEngine: widget.ctx.effectsEngine,
                    glitchIntensity: state.overlay.glitchIntensity,
                  );
                }
                return const _SignalLostTile();
              }).toList(growable: false);
              return _CctvWall(tiles: tiles, isStale: DateTime.now().isAfter(state.expiresAt));
            }
            return const _SignalLostTile();
          },
        );
      },
    );
  }
}

class _CctvWall extends StatelessWidget {
  const _CctvWall({required this.tiles, required this.isStale});

  final List<Widget> tiles;
  final bool isStale;

  @override
  Widget build(BuildContext context) {
    final List<Widget> paddedTiles = tiles
        .map((Widget tile) => Padding(
              padding: const EdgeInsets.all(4),
              child: tile,
            ))
        .toList(growable: false);
    return Stack(
      fit: StackFit.expand,
      children: <Widget>[
        LayoutBuilder(
          builder: (BuildContext context, BoxConstraints constraints) {
            final double width = constraints.maxWidth / 2;
            final double height = constraints.maxHeight / 2;
            return Wrap(
              children: List<Widget>.generate(4, (int index) {
                return SizedBox(
                  width: width,
                  height: height,
                  child: index < paddedTiles.length ? paddedTiles[index] : const _SignalLostTile(),
                );
              }),
            );
          },
        ),
        if (isStale)
          Positioned(
            right: 16,
            bottom: 16,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: Colors.orange.withOpacity(0.8),
                borderRadius: BorderRadius.circular(4),
              ),
              child: const Padding(
                padding: EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                child: Text('STALE PLAYLIST', style: HudTypography.camLabel),
              ),
            ),
          ),
      ],
    );
  }
}

class _CctvTile extends StatefulWidget {
  const _CctvTile({
    super.key,
    required this.clip,
    required this.timestampFormat,
    required this.effectsEngine,
    required this.glitchIntensity,
  });

  final PreparedClip clip;
  final String timestampFormat;
  final EffectsEngine effectsEngine;
  final double glitchIntensity;

  @override
  State<_CctvTile> createState() => _CctvTileState();
}

class _CctvTileState extends State<_CctvTile> {
  late VideoPlayerController _controller;
  bool _initialised = false;

  @override
  void initState() {
    super.initState();
    _initialiseController();
  }

  @override
  void didUpdateWidget(covariant _CctvTile oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.clip.file.file.path != widget.clip.file.file.path) {
      _initialiseController();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _initialiseController() async {
    if (_initialised) {
      await _controller.pause();
      await _controller.dispose();
    }
    _controller = VideoPlayerController.file(widget.clip.file.file);
    await _controller.initialize();
    await _controller.setLooping(true);
    await _controller.play();
    if (!mounted) {
      return;
    }
    setState(() {
      _initialised = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (!_initialised) {
      return const Center(child: CircularProgressIndicator());
    }
    return AspectRatio(
      aspectRatio: _controller.value.aspectRatio == 0 ? 16 / 9 : _controller.value.aspectRatio,
      child: _EffectOverlay(
        engine: widget.effectsEngine,
        glitchIntensity: widget.glitchIntensity,
        child: Stack(
          fit: StackFit.expand,
          children: <Widget>[
            VideoPlayer(_controller),
            HudOverlay(camLabel: widget.clip.item.label, timestampFormat: widget.timestampFormat),
          ],
        ),
      ),
    );
  }
}

class _SignalLostTile extends StatelessWidget {
  const _SignalLostTile();

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.black,
      child: const Center(
        child: Text(
          'SIGNAL LOST',
          style: TextStyle(color: Colors.redAccent, fontFamily: 'RobotoMono', fontSize: 20),
        ),
      ),
    );
  }
}

class _EffectOverlay extends StatelessWidget {
  const _EffectOverlay({required this.engine, required this.child, required this.glitchIntensity});

  final EffectsEngine engine;
  final Widget child;
  final double glitchIntensity;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: engine.enabled,
      builder: (BuildContext context, bool enabled, Widget? _) {
        if (!enabled) {
          return child;
        }
        return ValueListenableBuilder<EffectsPreset>(
          valueListenable: engine.preset,
          builder: (BuildContext context, EffectsPreset preset, Widget? _) {
            return Stack(
              fit: StackFit.expand,
              children: <Widget>[
                child,
                IgnorePointer(
                  child: CustomPaint(
                    painter: _ScanlinePainter(preset.scanlines * glitchIntensity),
                  ),
                ),
                IgnorePointer(
                  child: Container(
                    decoration: BoxDecoration(
                      gradient: RadialGradient(
                        colors: <Color>[
                          Colors.black.withOpacity(preset.vignette * 1.5),
                          Colors.transparent,
                        ],
                        radius: 1.2,
                      ),
                    ),
                  ),
                ),
                IgnorePointer(
                  child: Container(
                    color: Colors.white.withOpacity(preset.noise * 0.05 + glitchIntensity * 0.05),
                  ),
                ),
              ],
            );
          },
        );
      },
    );
  }
}

class _ScanlinePainter extends CustomPainter {
  _ScanlinePainter(this.intensity);

  final double intensity;

  @override
  void paint(Canvas canvas, Size size) {
    if (intensity <= 0) {
      return;
    }
    final Paint paint = Paint()
      ..color = Colors.black.withOpacity(0.12 * intensity)
      ..strokeWidth = 1;
    for (double y = 0; y < size.height; y += 2) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), paint);
    }
  }

  @override
  bool shouldRepaint(_ScanlinePainter oldDelegate) => oldDelegate.intensity != intensity;
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.error});

  final String error;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Text(
        error,
        style: const TextStyle(color: Colors.redAccent),
      ),
    );
  }
}
