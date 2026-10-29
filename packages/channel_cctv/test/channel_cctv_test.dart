import 'package:channel_api/channel_api.dart';
import 'package:channel_cctv/channel_cctv.dart';
import 'package:core_effects/core_effects.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

final class _FakeHandle implements PlaybackHandle {
  bool prepared = false;

  @override
  Future<void> prepare() async {
    prepared = true;
  }

  @override
  Future<void> activate() async {}
}

final class _FailingHandle implements PlaybackHandle {
  @override
  Future<void> prepare() async => throw StateError('coordinator offline');

  @override
  Future<void> activate() async {}
}

final class _FakeClock implements Clock {
  _FakeClock(this.current);

  DateTime current;

  @override
  DateTime now() => current;
}

/// Sixty-four lowercase hex chars (valid sha256 shape for fixtures).
const String _sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

PlaybackManifest _manifest({OverlaySettings overlay = const OverlaySettings()})
    => PlaybackManifest(
      partyId: 'party-1',
      channelId: hauntedSurveillanceChannelId,
      version: 3,
      publishedAt: DateTime.utc(2026, 10, 31, 20),
      clips: <ClipDescriptor>[
        for (int i = 0; i < 4; i++)
          ClipDescriptor(
            id: 'clip-0$i',
            cameraId: 'CAM-0${i + 1}',
            storageObjectId: 'obj-0$i',
            sha256: _sha,
            sizeBytes: 1024,
            duration: const Duration(seconds: 4),
            mimeType: 'video/mp4',
          ),
      ],
      overlay: overlay,
    );

void main() {
  group('tileFor', () {
    test('maps slots 0..3 to CAM-01..04 with rooms', () {
      expect(tileFor(0), (label: 'CAM-01 · hallway', cameraId: 'CAM-01'));
      expect(tileFor(1), (label: 'CAM-02 · kitchen', cameraId: 'CAM-02'));
      expect(tileFor(2), (label: 'CAM-03 · staircase', cameraId: 'CAM-03'));
      expect(
          tileFor(3), (label: 'CAM-04 · storage room', cameraId: 'CAM-04'));
    });

    test('rejects out-of-range slots', () {
      expect(() => tileFor(-1), throwsRangeError);
      expect(() => tileFor(4), throwsRangeError);
    });
  });

  group('HauntedSurveillancePlugin', () {
    test('descriptor is valid with wall capabilities', () {
      final ChannelPlugin plugin = const HauntedSurveillancePlugin();
      expect(plugin.descriptor.id, hauntedSurveillanceChannelId);
      expect(plugin.descriptor.title, 'Haunted Surveillance');
      expect(plugin.descriptor.version, greaterThan(0));
      expect(plugin.descriptor.capabilities.videoPlayback, isTrue);
      expect(plugin.descriptor.capabilities.effects, isTrue);
      expect(plugin.descriptor.capabilities.timedEvents, isTrue);
    });

    test('descriptor round-trips through json', () {
      const ChannelPlugin plugin = HauntedSurveillancePlugin();
      final ChannelDescriptor back =
          ChannelDescriptor.fromJson(plugin.descriptor.toJson());
      expect(back.id, hauntedSurveillanceChannelId);
      expect(back.capabilities, plugin.descriptor.capabilities);
    });

    test('is registry-compatible alongside sibling channels', () {
      // Inline registry shape (no kernel_app import needed); the sibling
      // stub stands in for RetroHorrorPlugin's descriptor id contract.
      final Map<String, ChannelPlugin> registry = <String, ChannelPlugin>{
        for (final ChannelPlugin p in <ChannelPlugin>[
          const HauntedSurveillancePlugin(),
          const _SiblingStubPlugin(),
        ])
          p.descriptor.id: p,
      };
      expect(registry['haunted_surveillance'],
          isA<HauntedSurveillancePlugin>());
      expect(registry['retro_horror'], isA<_SiblingStubPlugin>());
    });

    testWidgets('boots the wall with a fake coordinator',
        (WidgetTester tester) async {
      final _FakeHandle handle = _FakeHandle();
      final HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        disableEffects: true,
        tileBuilder: _fakeSurface,
        clock: _FakeClock(DateTime(2026, 10, 31, 20)),
      );
      final ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: handle,
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();
      expect(handle.prepared, isTrue);
      expect(find.text('CAM-01 · hallway'), findsOneWidget);
      expect(find.text('CAM-02 · kitchen'), findsOneWidget);
      expect(find.text('CAM-03 · staircase'), findsOneWidget);
      expect(find.text('CAM-04 · storage room'), findsOneWidget);
      expect(find.text('REC'), findsWidgets);
      expect(find.text('20:00:00'), findsNWidgets(4));
      expect(find.text('SIGNAL LOST'), findsNothing);
    });

    testWidgets('uses manifest camera ids when provided',
        (WidgetTester tester) async {
      final _FakeHandle handle = _FakeHandle();
      final HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        disableEffects: true,
        manifest: _manifest(),
        tileBuilder: _fakeSurface,
      );
      final ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: handle,
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();
      expect(find.text('CAM-01 · clip-00'), findsOneWidget);
      expect(find.text('CAM-04 · clip-03'), findsOneWidget);
    });

    testWidgets('manifest overlay tunes the tile effect intensities',
        (WidgetTester tester) async {
      final HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        manifest: _manifest(
          overlay: const OverlaySettings(
            scanlineOpacity: 0.8,
            noiseLevel: 0.05,
            vignette: 0.3,
          ),
        ),
        tileBuilder: _fakeSurface,
        clock: _FakeClock(DateTime(2026, 10, 31, 20)),
      );
      final ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: _FakeHandle(),
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();

      final Iterable<CustomPaint> scanlines = tester.widgetList<CustomPaint>(
        find.byWidgetPredicate(
          (Widget w) => w is CustomPaint && w.painter is ScanlinesPainter,
        ),
      );
      expect(scanlines, hasLength(4));
      expect(
        (scanlines.first.painter! as ScanlinesPainter).opacity,
        closeTo(0.1 + 0.25 * 0.8, 1e-9),
      );

      final Iterable<CustomPaint> vignettes = tester.widgetList<CustomPaint>(
        find.byWidgetPredicate(
          (Widget w) => w is CustomPaint && w.painter is VignettePainter,
        ),
      );
      expect(vignettes, hasLength(4));
      expect((vignettes.first.painter! as VignettePainter).strength, 0.3);
    });

    testWidgets('default wall wires scanline + vignette overlays per tile',
        (WidgetTester tester) async {
      final HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        tileBuilder: _fakeSurface,
        clock: _FakeClock(DateTime(2026, 10, 31, 20)),
      );
      final ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: _FakeHandle(),
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();

      final Finder scanlines = find.byWidgetPredicate(
        (Widget w) => w is CustomPaint && w.painter is ScanlinesPainter,
      );
      final Finder vignette = find.byWidgetPredicate(
        (Widget w) => w is CustomPaint && w.painter is VignettePainter,
      );
      expect(scanlines, findsNWidgets(4));
      expect(vignette, findsNWidgets(4));
      expect(find.byKey(const Key('surface-CAM-01')), findsOneWidget);
    });

    testWidgets('disableEffects removes painters from every tile',
        (WidgetTester tester) async {
      final HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        disableEffects: true,
        tileBuilder: _fakeSurface,
        clock: _FakeClock(DateTime(2026, 10, 31, 20)),
      );
      final ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: _FakeHandle(),
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();
      expect(
        find.byWidgetPredicate(
          (Widget w) => w is CustomPaint && w.painter is ScanlinesPainter,
        ),
        findsNothing,
      );
    });

    testWidgets('coordinator boot failure degrades to SignalLost, wall survives',
        (WidgetTester tester) async {
      const HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        disableEffects: true,
        tileBuilder: _fakeSurface,
      );
      final ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: _FailingHandle(),
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();
      expect(find.text('SIGNAL LOST'), findsNWidgets(4));
      expect(tester.takeException(), isNull);
    });

    testWidgets('a throwing surface degrades to SignalLost, wall survives',
        (WidgetTester tester) async {
      const HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        disableEffects: true,
        tileBuilder: _throwingSurface,
      );
      final ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: _FakeHandle(),
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();
      expect(find.text('SIGNAL LOST'), findsNWidgets(4));
      expect(tester.takeException(), isNull);
    });

    testWidgets('build applies wall config from ChannelContext.settings',
        (WidgetTester tester) async {
      // Constructor leaves effects on, but the host disables them via the
      // channel contract: settings win without re-instantiating the plugin.
      final HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        tileBuilder: _fakeSurface,
        clock: _FakeClock(DateTime(2026, 10, 31, 20)),
      );
      final ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: _FakeHandle(),
        settings: const ChannelSettings(<String, Object?>{
          'effectsDisabled': true,
          'manifestVersion': 7,
          'overscanSafe': true,
          'labels': <String, String>{'CAM-01': 'PORCH · custom'},
        }),
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();

      expect(
        find.byWidgetPredicate(
          (Widget w) => w is CustomPaint && w.painter is ScanlinesPainter,
        ),
        findsNothing,
        reason: 'settings effectsDisabled must drop overlays',
      );
      expect(find.text('PORCH · custom'), findsOneWidget);
      expect(find.text('CAM-02 · kitchen'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('constructor wall config still applies with empty settings',
        (WidgetTester tester) async {
      final HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        disableEffects: true,
        tileBuilder: _fakeSurface,
        clock: _FakeClock(DateTime(2026, 10, 31, 20)),
      );
      final ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: _FakeHandle(),
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();

      expect(
        find.byWidgetPredicate(
          (Widget w) => w is CustomPaint && w.painter is ScanlinesPainter,
        ),
        findsNothing,
      );
      expect(find.text('CAM-01 · hallway'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}

Widget _fakeSurface(
  BuildContext context,
  int index,
  String label,
  String cameraId,
) =>
    Container(color: Colors.black, key: Key('surface-$cameraId'));

Widget _throwingSurface(
  BuildContext context,
  int index,
  String label,
  String cameraId,
) {
  throw StateError('no decoder in tests');
}

/// Inline stand-in for a sibling channel's descriptor id contract.
final class _SiblingStubPlugin implements ChannelPlugin {
  const _SiblingStubPlugin();

  @override
  ChannelDescriptor get descriptor => const ChannelDescriptor(
        id: 'retro_horror',
        title: 'Retro Horror',
        version: 1,
      );

  @override
  Widget build(ChannelContext context) => const SizedBox.shrink();
}
