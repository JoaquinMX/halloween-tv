/// Wall widget tests: real channel chrome + app-owned decoders.
library;

import 'dart:io';

import 'package:channel_api/channel_api.dart';
import 'package:channel_cctv/channel_cctv.dart';
import 'package:core_cache/core_cache.dart';
import 'package:core_effects/core_effects.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:core_ui/core_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_settings/infra_settings.dart' show SharedPreferencesSettings;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:testing_toolkit/testing_toolkit.dart';
import 'package:tv_app/src/playback/camera_tile.dart';
import 'package:tv_app/src/playback/tile_video_controller.dart';
import 'package:tv_app/src/wall/wall_screen.dart';

import 'support/fakes.dart';

Widget wallHarness({
  required PlaybackManifest manifest,
  required TileVideoControllerFactory factory,
  required FakeClock clock,
  Future<PlaybackManifest?> Function()? onRetryCached,
  Map<String, CachedMedia> mediaByClipId = const <String, CachedMedia>{},
  Future<bool> Function(String path)? fileExists,
  SettingsPort? settings,
  bool initialEffectsDisabled = false,
  bool recoveryEnabled = true,
}) {
  return MaterialApp(
    theme: CctvTheme.dark(),
    home: WallScreen(
      plugin: const HauntedSurveillancePlugin(),
      manifest: manifest,
      mediaByClipId: mediaByClipId,
      settings: settings,
      initialEffectsDisabled: initialEffectsDisabled,
      clock: clock,
      profile: cctvProfile(),
      tileControllerFactory: factory,
      onRetryCached: onRetryCached,
      fileExists: fileExists,
      recoveryEnabled: recoveryEnabled,
    ),
  );
}

/// Pumps through CctvWall.prepare() + the four tile initialisation futures.
Future<void> pumpWall(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 16));
  await tester.pump();
}

/// Tears the tree down so periodic HUD/glitch timers are cancelled.
Future<void> teardownWall(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
}

PlaybackManifest wallManifest({int version = 1}) => manifestFixture(
      partyId: 'local-party',
      channelId: hauntedSurveillanceChannelId,
      version: version,
    );

/// Real on-disk bytes for the verified-local-file test.
///
/// Created once in setUpAll (real async zone): testWidgets bodies run in a
/// FakeAsync zone where real dart:io never completes, so file setup cannot
/// live in the test body.
/// Late-initialized in setUpAll; torn down in tearDownAll.
late Directory wallFilesRoot;

void main() {
  final FakeClock clock = FakeClock(DateTime.utc(2026, 10, 31, 20));

  setUpAll(() async {
    wallFilesRoot = await Directory.systemTemp.createTemp('tv-wall-files-');
    for (var index = 1; index <= 4; index++) {
      final File file = File('${wallFilesRoot.path}/local-clip-$index.media');
      await file.writeAsBytes(<int>[1, 2, 3, index], flush: true);
    }
  });

  tearDownAll(() async {
    if (await wallFilesRoot.exists()) {
      await wallFilesRoot.delete(recursive: true);
    }
  });

  testWidgets('committed clip IDs resolve to their verified local file sources',
      (WidgetTester tester) async {
    final List<ClipDescriptor> clips = <ClipDescriptor>[
      for (var index = 1; index <= 4; index++)
        ClipDescriptor(
          id: 'local-clip-$index',
          cameraId: 'CAM-0$index',
          storageObjectId: 'assets/cam0$index.mp4',
          sha256: sha256Hex(<int>[1, 2, 3, index]),
          sizeBytes: 4,
          duration: const Duration(seconds: 2),
          mimeType: 'video/mp4',
        ),
    ];
    final PlaybackManifest manifest = PlaybackManifest(
      partyId: 'local-party',
      channelId: hauntedSurveillanceChannelId,
      version: 1,
      clips: clips,
      publishedAt: DateTime.utc(2026, 10, 31),
    );
    final Map<String, CachedMedia> media = <String, CachedMedia>{};
    for (var index = 0; index < manifest.clips.length; index++) {
      final ClipDescriptor clip = manifest.clips[index];
      final File file = File('${wallFilesRoot.path}/${clip.id}.media');
      media[clip.id] = CachedMedia(
        clipId: clip.id,
        localRef: file.absolute.path,
        sha256: clip.sha256,
      );
    }
    final Map<String, FakeTileVideoController> sink =
        <String, FakeTileVideoController>{};

    final Set<String> committedPaths = <String>{
      for (final CachedMedia entry in media.values) entry.localRef,
    };
    await tester.pumpWidget(wallHarness(
      manifest: manifest,
      clock: clock,
      factory: fakeControllerFactory(sink: sink),
      mediaByClipId: media,
      fileExists: (String path) async => committedPaths.contains(path),
    ));
    await pumpWall(tester);

    for (final ClipDescriptor clip in manifest.clips) {
      expect(sink[clip.cameraId]!.source, isA<LocalFileSource>());
      expect((sink[clip.cameraId]!.source as LocalFileSource).path,
          media[clip.id]!.localRef);
    }
    await teardownWall(tester);
  });

  testWidgets('effects preference persists by party and restores on the next wall',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final SharedPreferencesSettings settings = SharedPreferencesSettings();
    await tester.pumpWidget(wallHarness(
      manifest: wallManifest(),
      clock: clock,
      factory: fakeControllerFactory(),
      settings: settings,
    ));
    await pumpWall(tester);
    await tester.sendKeyEvent(LogicalKeyboardKey.contextMenu);
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey<String>('recovery-toggle-effects')));
    await tester.pump();
    expect(await settings.getBool(
      partyId: PartyId('local-party'),
      key: CctvWallSettingsKeys.effectsDisabled,
    ), isTrue);
    expect(await settings.getBool(
      partyId: PartyId('other-party'),
      key: CctvWallSettingsKeys.effectsDisabled,
    ), isNull);
    await teardownWall(tester);

    await tester.pumpWidget(wallHarness(
      manifest: wallManifest(),
      clock: clock,
      factory: fakeControllerFactory(),
      settings: settings,
      initialEffectsDisabled: await settings.getBool(
        partyId: PartyId('local-party'),
        key: CctvWallSettingsKeys.effectsDisabled,
      ) ?? false,
    ));
    await pumpWall(tester);
    expect(find.byWidgetPredicate(
      (Widget widget) => widget is CctvTile && widget.disableEffects,
    ), findsNWidgets(4));
    await teardownWall(tester);
  });

  testWidgets('renders four camera tiles with a ticking HUD per tile',
      (WidgetTester tester) async {
    final Map<String, FakeTileVideoController> sink =
        <String, FakeTileVideoController>{};

    await tester.pumpWidget(
      wallHarness(
        manifest: wallManifest(),
        clock: clock,
        factory: fakeControllerFactory(sink: sink),
      ),
    );
    await pumpWall(tester);

    expect(find.text('20:00:00'), findsNWidgets(4));
    expect(find.text('REC'), findsNWidgets(4));
    // Labels resolve through core_playlist: manifest clip labels when
    // present, else the canonical slot defaults (owner Q3).
    expect(find.text(cctvSlots[0].defaultLabel), findsOneWidget);
    expect(find.text(cctvSlots[3].defaultLabel), findsOneWidget);
    // The wall sizes itself from the viewport (no scrollable overflow).
    expect(find.byType(Scrollable), findsNothing);

    for (final String cameraId in <String>[
      'CAM-01',
      'CAM-02',
      'CAM-03',
      'CAM-04',
    ]) {
      expect(
        find.byKey(ValueKey<String>('video-surface-$cameraId')),
        findsOneWidget,
      );
      final FakeTileVideoController controller = sink[cameraId]!;
      expect(controller.calls.first, 'initialize');
      expect(controller.looping, isTrue, reason: 'clips must loop');
      expect(controller.volume, 0, reason: 'the wall is muted');
      expect(controller.playing, isTrue, reason: 'autoplay after init');
    }

    // The HUD timestamp is a live wall clock, not a frozen string.
    clock.advance(const Duration(hours: 1, minutes: 2, seconds: 3));
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('21:02:03'), findsNWidgets(4));

    await teardownWall(tester);
    expect(sink['CAM-01']!.disposed, isTrue);
  });

  testWidgets('D-pad arrows move focus between the four tiles',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      wallHarness(
        manifest: wallManifest(),
        clock: clock,
        factory: fakeControllerFactory(),
      ),
    );
    await pumpWall(tester);

    expect(find.byKey(const ValueKey<String>('tile-focus-ring-0')),
        findsOneWidget);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump();
    expect(find.byKey(const ValueKey<String>('tile-focus-ring-1')),
        findsOneWidget);
    expect(find.byKey(const ValueKey<String>('tile-focus-ring-0')),
        findsNothing);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(find.byKey(const ValueKey<String>('tile-focus-ring-3')),
        findsOneWidget);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.pump();
    expect(find.byKey(const ValueKey<String>('tile-focus-ring-1')),
        findsOneWidget);

    // Left edge: focus stays put instead of wrapping.
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pump();
    expect(find.byKey(const ValueKey<String>('tile-focus-ring-0')),
        findsOneWidget);

    await teardownWall(tester);
  });

  testWidgets('a decoder that fails to initialize shows SIGNAL LOST only for '
      'that tile', (WidgetTester tester) async {
    await tester.pumpWidget(
      wallHarness(
        manifest: wallManifest(),
        clock: clock,
        factory: fakeControllerFactory(failing: <String>{'CAM-02'}),
      ),
    );
    await pumpWall(tester);

    expect(find.text('SIGNAL LOST'), findsOneWidget);
    // Wall survives: the other three feeds keep playing...
    expect(find.byKey(const ValueKey<String>('video-surface-CAM-01')),
        findsOneWidget);
    expect(find.byKey(const ValueKey<String>('video-surface-CAM-03')),
        findsOneWidget);
    expect(find.byKey(const ValueKey<String>('video-surface-CAM-04')),
        findsOneWidget);
    expect(find.byKey(const ValueKey<String>('video-surface-CAM-02')),
        findsNothing);
    // ...and the failed tile keeps its HUD identity.
    expect(find.text(cctvSlots[1].defaultLabel), findsOneWidget);

    await teardownWall(tester);
  });

  testWidgets('a late decoder error flips a live tile to SIGNAL LOST',
      (WidgetTester tester) async {
    final Map<String, FakeTileVideoController> sink =
        <String, FakeTileVideoController>{};
    await tester.pumpWidget(
      wallHarness(
        manifest: wallManifest(),
        clock: clock,
        factory: fakeControllerFactory(sink: sink),
      ),
    );
    await pumpWall(tester);
    expect(find.text('SIGNAL LOST'), findsNothing);

    sink['CAM-03']!.emitError();
    await tester.pump();

    expect(find.text('SIGNAL LOST'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('video-surface-CAM-01')),
        findsOneWidget);

    await teardownWall(tester);
  });

  testWidgets('recovery panel is hidden until OK long-press or MENU',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      wallHarness(
        manifest: wallManifest(),
        clock: clock,
        factory: fakeControllerFactory(),
      ),
    );
    await pumpWall(tester);

    expect(find.byKey(kRecoveryOverlayKey), findsNothing);

    // MENU key reveals the panel.
    await tester.sendKeyEvent(LogicalKeyboardKey.contextMenu);
    await tester.pump();
    await tester.pump();
    expect(find.byKey(kRecoveryOverlayKey), findsOneWidget);
    expect(find.text('RETRY CACHED WALL'), findsOneWidget);
    expect(find.text('DISABLE EFFECTS'), findsOneWidget);

    // Focus is trapped inside the panel: the first action owns it and D-pad
    // input no longer moves wall tiles behind the overlay.
    final OutlinedButton retryButton = tester.widget<OutlinedButton>(
      find.byKey(const ValueKey<String>('recovery-retry')),
    );
    expect(retryButton.focusNode!.hasFocus, isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(find.byKey(const ValueKey<String>('tile-focus-ring-1')),
        findsNothing);

    // MENU closes it again.
    await tester.sendKeyEvent(LogicalKeyboardKey.contextMenu);
    await tester.pump();
    expect(find.byKey(kRecoveryOverlayKey), findsNothing);
    // ...and focus returns to the wall (post-frame restore + tile rebuild).
    await tester.pump();
    expect(find.byKey(const ValueKey<String>('tile-focus-ring-0')),
        findsOneWidget);

    // OK long-press also reveals it.
    await tester.sendKeyDownEvent(LogicalKeyboardKey.select);
    await tester.pump(const Duration(milliseconds: 700));
    expect(find.byKey(kRecoveryOverlayKey), findsOneWidget);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.select);
    await tester.pump();

    await teardownWall(tester);
  });

  testWidgets('recovery panel can disable effect overlays',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      wallHarness(
        manifest: wallManifest(),
        clock: clock,
        factory: fakeControllerFactory(),
      ),
    );
    await pumpWall(tester);

    expect(
      find.byWidgetPredicate(
        (Widget widget) => widget is CustomPaint &&
            widget.painter is ScanlinesPainter,
      ),
      findsWidgets,
      reason: 'cctv profile draws scanlines over every tile',
    );

    await tester.sendKeyEvent(LogicalKeyboardKey.contextMenu);
    await tester.pump();
    await tester.tap(
      find.byKey(const ValueKey<String>('recovery-toggle-effects')),
    );
    await tester.pump();
    await tester.pump();

    expect(
      find.byWidgetPredicate(
        (Widget widget) => widget is CustomPaint &&
            widget.painter is ScanlinesPainter,
      ),
      findsNothing,
    );
    expect(
      find.byWidgetPredicate(
        (Widget widget) => widget is CctvTile && widget.disableEffects,
      ),
      findsNWidgets(4),
    );
    // Video keeps playing while effects are off.
    expect(find.byKey(const ValueKey<String>('video-surface-CAM-01')),
        findsOneWidget);

    await teardownWall(tester);
  });

  testWidgets('retry cached wall reuses decoders within a budget of 4',
      (WidgetTester tester) async {
    final List<String> events = <String>[];
    int live = 0;
    int maxLive = 0;
    final Map<String, FakeTileVideoController> sink =
        <String, FakeTileVideoController>{};
    TileVideoController trackingFactory({
      required String cameraId,
      required TileMediaSource source,
    }) {
      final FakeTileVideoController inner = FakeTileVideoController(
        cameraId: cameraId,
        source: source,
      );
      sink[cameraId] = inner;
      return _LiveBudgetController(
        inner: inner,
        onInitialize: () {
          live++;
          if (live > maxLive) {
            maxLive = live;
          }
          events.add('init $cameraId');
        },
        onDispose: () {
          events.add('dispose $cameraId');
          live--;
        },
      );
    }

    final PlaybackManifest cached = wallManifest(version: 9);

    await tester.pumpWidget(
      wallHarness(
        manifest: wallManifest(),
        clock: clock,
        factory: trackingFactory,
        onRetryCached: () async => cached,
      ),
    );
    await pumpWall(tester);
    expect(sink, hasLength(4));
    expect(maxLive, 4);

    await tester.sendKeyEvent(LogicalKeyboardKey.contextMenu);
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey<String>('recovery-retry')));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 16));

    expect(find.text('WALL RESTORED · v9'), findsOneWidget);
    expect(find.byKey(kRecoveryOverlayKey), findsNothing);
    // Same camera set: stable cameraId tile keys reuse the four decoders
    // instead of transiently doubling to 8 (dispose-before-create budget).
    expect(maxLive, lessThanOrEqualTo(4));
    expect(events.where((String e) => e.startsWith('init')), hasLength(4));
    expect(events.where((String e) => e.startsWith('dispose')), isEmpty);
    expect(live, 4);
    for (final String cameraId in <String>[
      'CAM-01',
      'CAM-02',
      'CAM-03',
      'CAM-04',
    ]) {
      expect(
        find.byKey(ValueKey<String>('video-surface-$cameraId')),
        findsOneWidget,
      );
      expect(sink[cameraId]!.disposed, isFalse);
    }

    await teardownWall(tester);
    expect(live, 0);
  });

  testWidgets('retry without a cached wall keeps the current feed',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      wallHarness(
        manifest: wallManifest(),
        clock: clock,
        factory: fakeControllerFactory(),
        onRetryCached: () async => null,
      ),
    );
    await pumpWall(tester);

    await tester.sendKeyEvent(LogicalKeyboardKey.contextMenu);
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey<String>('recovery-retry')));
    await tester.pump();
    await tester.pump();

    expect(find.text('NO CACHED WALL · KEEPING CURRENT FEED'),
        findsOneWidget);
    expect(find.byKey(kRecoveryOverlayKey), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('video-surface-CAM-01')),
        findsOneWidget);

    await teardownWall(tester);
  });

  testWidgets('wall fits the viewport at 960x540 and 1280x720',
      (WidgetTester tester) async {
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    for (final Size size in <Size>[
      const Size(960, 540),
      const Size(1280, 720),
    ]) {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1.0;
      await tester.pumpWidget(
        wallHarness(
          manifest: wallManifest(),
          clock: clock,
          factory: fakeControllerFactory(),
        ),
      );
      await pumpWall(tester);

      final Rect viewport = Offset.zero & size;
      for (final String cameraId in <String>[
        'CAM-01',
        'CAM-02',
        'CAM-03',
        'CAM-04',
      ]) {
        final Finder surface =
            find.byKey(ValueKey<String>('video-surface-$cameraId'));
        expect(surface, findsOneWidget);
        final Rect rect = tester.getRect(surface);
        expect(rect.width, greaterThan(0));
        expect(rect.height, greaterThan(0));
        expect(
          viewport.contains(rect.topLeft) &&
              viewport.contains(rect.bottomRight),
          isTrue,
          reason: '$cameraId rect $rect must sit fully on-screen at $size',
        );
        // The tile (surface + HUD + focus chrome) is what the D-pad
        // drives: it must be fully on-screen and hit-testable. (The raw
        // surface sits under tile chrome, so hit-testing targets the tile.)
        final Finder tile =
            find.byKey(ValueKey<String>('camera-tile-$cameraId'));
        expect(tile, findsOneWidget);
        final Rect tileRect = tester.getRect(tile);
        expect(
          viewport.contains(tileRect.topLeft) &&
              viewport.contains(tileRect.bottomRight),
          isTrue,
          reason:
              '$cameraId tile $tileRect must sit fully on-screen at $size',
        );
        expect(
          tile.hitTestable(),
          findsOneWidget,
          reason: '$cameraId must be hit-testable at $size',
        );
      }
      // No scrollable: the whole wall is laid out from viewport constraints.
      expect(find.byType(Scrollable), findsNothing);
      expect(tester.takeException(), isNull);

      await teardownWall(tester);
    }
  });

  testWidgets('CameraTile swaps feeds dispose-before-create',
      (WidgetTester tester) async {
    final List<String> events = <String>[];
    final Map<String, FakeTileVideoController> innerSink =
        <String, FakeTileVideoController>{};
    TileVideoController trackingFactory({
      required String cameraId,
      required TileMediaSource source,
    }) {
      final FakeTileVideoController inner = FakeTileVideoController(
        cameraId: cameraId,
        source: source,
      );
      innerSink['$cameraId#${inner.hashCode}'] = inner;
      return _LiveBudgetController(
        inner: inner,
        onInitialize: () => events.add('init $cameraId'),
        onDispose: () => events.add('dispose $cameraId'),
      );
    }

    final FocusNode focusNode = FocusNode(debugLabel: 'swap-tile');
    addTearDown(focusNode.dispose);
    Widget harness(String cameraId) => MaterialApp(
          home: Scaffold(
            body: CameraTile(
              key: const ValueKey<String>('slot-0'),
              index: 0,
              cameraId: cameraId,
              source: BundledAssetSource('assets/${cameraId.toLowerCase()}.mp4'),
              focusNode: focusNode,
              controllerFactory: trackingFactory,
            ),
          ),
        );

    await tester.pumpWidget(harness('CAM-01'));
    await tester.pump();
    await tester.pump();
    expect(
      find.byKey(const ValueKey<String>('video-surface-CAM-01')),
      findsOneWidget,
    );

    await tester.pumpWidget(harness('CAM-02'));
    await tester.pump();
    await tester.pump();
    await tester.pump();
    expect(
      find.byKey(const ValueKey<String>('video-surface-CAM-02')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey<String>('video-surface-CAM-01')),
      findsNothing,
    );
    // The old decoder was released before the replacement initialized.
    expect(events, <String>['init CAM-01', 'dispose CAM-01', 'init CAM-02']);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });

  testWidgets('failed local decoder restores the previous bundled source',
      (WidgetTester tester) async {
    final List<FakeTileVideoController> controllers =
        <FakeTileVideoController>[];
    int liveDecoders = 0;
    int maximumLiveDecoders = 0;
    bool? settled;
    TileVideoController rollbackFactory({
      required String cameraId,
      required TileMediaSource source,
    }) {
      final FakeTileVideoController inner = FakeTileVideoController(
        cameraId: cameraId,
        source: source,
        failOnInitialize: source is LocalFileSource,
      );
      controllers.add(inner);
      return _LiveBudgetController(
        inner: inner,
        onInitialize: () {
          liveDecoders++;
          if (liveDecoders > maximumLiveDecoders) {
            maximumLiveDecoders = liveDecoders;
          }
        },
        onDispose: () {
          if (inner.isInitialized) liveDecoders--;
        },
      );
    }

    final FocusNode focusNode = FocusNode(debugLabel: 'rollback-tile');
    addTearDown(focusNode.dispose);
    Widget tile(TileMediaSource source) => MaterialApp(
          home: Scaffold(
            body: CameraTile(
              key: const ValueKey<String>('rollback-slot'),
              index: 0,
              cameraId: 'CAM-01',
              source: source,
              focusNode: focusNode,
              controllerFactory: rollbackFactory,
              onSourceSettled: (bool success) => settled = success,
            ),
          ),
        );

    const BundledAssetSource previous = BundledAssetSource('assets/cam01.mp4');
    await tester.pumpWidget(tile(previous));
    await tester.pump();
    await tester.pump();
    expect(find.text('LIVE CAM-01'), findsOneWidget);

    await tester.pumpWidget(tile(const LocalFileSource('/cache/rejected.mp4')));
    for (var frame = 0; frame < 8; frame++) {
      await tester.pump(const Duration(milliseconds: 1));
    }

    expect(settled, isFalse);
    expect(find.text('LIVE CAM-01'), findsOneWidget);
    expect(find.text('SIGNAL LOST'), findsNothing);
    expect(controllers, hasLength(3));
    expect(controllers[0].disposed, isTrue);
    expect(controllers[1].disposed, isTrue);
    expect(controllers[2].source, previous);
    expect(controllers[2].playing, isTrue);
    expect(maximumLiveDecoders, 1);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    expect(liveDecoders, 0);
  });
}

/// [TileVideoController] decorator tracking decoder-budget events.
///
/// Delegates everything to [inner] while reporting lifecycle transitions,
/// so tests can assert the wall never exceeds its live-decoder budget.
final class _LiveBudgetController implements TileVideoController {
  _LiveBudgetController({
    required this.inner,
    required this.onInitialize,
    required this.onDispose,
  });

  final FakeTileVideoController inner;
  final void Function() onInitialize;
  final void Function() onDispose;

  @override
  Future<void> initialize() async {
    await inner.initialize();
    onInitialize();
  }

  @override
  bool get isInitialized => inner.isInitialized;

  @override
  bool get hasError => inner.hasError;

  @override
  String? get errorDescription => inner.errorDescription;

  @override
  Widget buildSurface(BuildContext context) => inner.buildSurface(context);

  @override
  Future<void> setLooping(bool looping) => inner.setLooping(looping);

  @override
  Future<void> setVolume(double volume) => inner.setVolume(volume);

  @override
  Future<void> play() => inner.play();

  @override
  void addListener(VoidCallback listener) => inner.addListener(listener);

  @override
  void removeListener(VoidCallback listener) =>
      inner.removeListener(listener);

  @override
  Future<void> dispose() async {
    await inner.dispose();
    onDispose();
  }
}
