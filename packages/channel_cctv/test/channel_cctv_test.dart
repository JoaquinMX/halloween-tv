import 'dart:io';

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
const String _sha =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

PlaybackManifest _manifest({
  OverlaySettings overlay = const OverlaySettings(),
  Map<String, String?> labels = const <String, String?>{},
  bool reverseClipOrder = false,
}) {
  final List<ClipDescriptor> clips = <ClipDescriptor>[
    for (int i = 0; i < 4; i++)
      ClipDescriptor(
        id: 'clip-0$i',
        cameraId: 'CAM-0${i + 1}',
        storageObjectId: 'obj-0$i',
        sha256: _sha,
        sizeBytes: 1024,
        duration: const Duration(seconds: 4),
        mimeType: 'video/mp4',
        label: labels['CAM-0${i + 1}'],
      ),
  ];
  return PlaybackManifest(
    partyId: 'party-1',
    channelId: hauntedSurveillanceChannelId,
    version: 3,
    publishedAt: DateTime.utc(2026, 10, 31, 20),
    clips: reverseClipOrder ? clips.reversed.toList() : clips,
    overlay: overlay,
  );
}

void main() {
  group('tileFor', () {
    test('maps slots 0..3 to CAM-01..04 with rooms', () {
      expect(tileFor(0), (label: 'CAM-01 · hallway', cameraId: 'CAM-01'));
      expect(tileFor(1), (label: 'CAM-02 · kitchen', cameraId: 'CAM-02'));
      expect(tileFor(2), (label: 'CAM-03 · staircase', cameraId: 'CAM-03'));
      expect(tileFor(3), (label: 'CAM-04 · storage room', cameraId: 'CAM-04'));
    });

    test('rejects out-of-range slots', () {
      expect(() => tileFor(-1), throwsRangeError);
      expect(() => tileFor(4), throwsRangeError);
    });

    test('slot list and labels derive from core_playlist cctvSlots', () {
      expect(cctvCameraIds, cctvSlots.map((CctvSlot s) => s.id).toList());
      expect(cctvRooms, cctvSlots.map((CctvSlot s) => s.room).toList());
      expect(() => cctvCameraIds.add('CAM-99'), throwsUnsupportedError);
      expect(() => cctvRooms.add('attic'), throwsUnsupportedError);
    });

    test('a custom label overrides the slot default, blank keeps it', () {
      expect(tileFor(0, label: 'Front Door'), (
        label: 'Front Door',
        cameraId: 'CAM-01',
      ));
      expect(tileFor(0, label: '   '), (
        label: cctvSlots[0].defaultLabel,
        cameraId: 'CAM-01',
      ));
      expect(tileFor(0), (
        label: cctvSlots[0].defaultLabel,
        cameraId: 'CAM-01',
      ));
    });

    test('tileForCamera places by camera identity, not index', () {
      expect(tileForCamera('CAM-03', label: 'Stairs'), (
        label: 'Stairs',
        cameraId: 'CAM-03',
      ));
      expect(() => tileForCamera('CAM-09'), throwsArgumentError);
    });

    test('tileForClip resolves config labels, else slot defaults', () {
      ClipDescriptor clip(String cameraId, {String? label}) => ClipDescriptor(
        id: 'clip-$cameraId',
        cameraId: cameraId,
        storageObjectId: 'obj-$cameraId',
        sha256: _sha,
        sizeBytes: 1024,
        duration: const Duration(seconds: 4),
        mimeType: 'video/mp4',
        label: label,
      );
      expect(tileForClip(clip('CAM-02', label: 'Kitchen Cam')), (
        label: 'Kitchen Cam',
        cameraId: 'CAM-02',
      ));
      expect(tileForClip(clip('CAM-04')), (
        label: cctvSlots[3].defaultLabel,
        cameraId: 'CAM-04',
      ));
    });
  });

  group('HauntedSurveillancePlugin', () {
    test('descriptor is valid with wall capabilities', () {
      const ChannelPlugin plugin = HauntedSurveillancePlugin();
      expect(plugin.descriptor.id, hauntedSurveillanceChannelId);
      expect(plugin.descriptor.title, 'Haunted Surveillance');
      expect(plugin.descriptor.version, greaterThan(0));
      expect(plugin.descriptor.capabilities.videoPlayback, isTrue);
      expect(plugin.descriptor.capabilities.effects, isTrue);
      expect(plugin.descriptor.capabilities.timedEvents, isTrue);
    });

    test('descriptor round-trips through json', () {
      const ChannelPlugin plugin = HauntedSurveillancePlugin();
      final ChannelDescriptor back = ChannelDescriptor.fromJson(
        plugin.descriptor.toJson(),
      );
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
      expect(
        registry['haunted_surveillance'],
        isA<HauntedSurveillancePlugin>(),
      );
      expect(registry['retro_horror'], isA<_SiblingStubPlugin>());
    });

    testWidgets('boots the wall with a fake coordinator', (
      WidgetTester tester,
    ) async {
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

    testWidgets(
      'manifest without labels falls back to core_playlist defaults',
      (WidgetTester tester) async {
        // Manifest clips carry no `label`: wall labels must resolve to the
        // canonical slot defaults from core_playlist, never to clip ids.
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
        for (final CctvSlot slot in cctvSlots) {
          expect(find.text(slot.defaultLabel), findsOneWidget);
        }
        expect(find.textContaining('clip-0'), findsNothing);
      },
    );

    testWidgets('custom-label manifest drives wall slot labels end-to-end', (
      WidgetTester tester,
    ) async {
      // Owner Q3: labels are config-driven. A manifest whose clips carry
      // `label` must drive the HUD text on the matching camera slot, while
      // slots without a label keep the core_playlist default.
      final _FakeHandle handle = _FakeHandle();
      final HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        disableEffects: true,
        manifest: _manifest(
          labels: const <String, String?>{
            'CAM-01': 'Front Door',
            'CAM-02': null,
            'CAM-03': 'Basement',
            'CAM-04': '   ',
          },
        ),
        tileBuilder: _fakeSurface,
      );
      final ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: handle,
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();
      expect(find.text('Front Door'), findsOneWidget);
      expect(find.text('CAM-02 · kitchen'), findsOneWidget);
      expect(find.text('Basement'), findsOneWidget);
      expect(find.text('CAM-04 · storage room'), findsOneWidget);
      // Blank labels are not rendered as-is.
      expect(find.text('   '), findsNothing);
    });

    testWidgets('slots follow camera identity, not manifest clip order', (
      WidgetTester tester,
    ) async {
      final _FakeHandle handle = _FakeHandle();
      final HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        disableEffects: true,
        manifest: _manifest(
          labels: const <String, String?>{
            'CAM-01': 'Front Door',
            'CAM-02': 'Kitchen Cam',
            'CAM-03': 'Stairs',
            'CAM-04': 'Vault',
          },
          reverseClipOrder: true,
        ),
        tileBuilder: _fakeSurface,
      );
      final ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: handle,
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();
      // Labels are placed by camera id, so reversed clip order still puts
      // CAM-01's label on wall slot 0.
      final Text first = tester.widget<Text>(find.text('Front Door'));
      expect(first.data, 'Front Door');
      expect(
        tester.getTopLeft(find.text('Front Door')).dx,
        lessThan(tester.getTopLeft(find.text('Kitchen Cam')).dx),
      );
      expect(
        tester.getTopLeft(find.text('Stairs')).dy,
        greaterThan(tester.getTopLeft(find.text('Kitchen Cam')).dy),
      );
    });

    testWidgets('unknown-camera manifest degrades to defaults per slot', (
      WidgetTester tester,
    ) async {
      // Validation rejects unknown camera ids upstream (core_playlist), but
      // a stale payload must never crash the wall: an unmatched clip is
      // ignored and its slot keeps the canonical default.
      final _FakeHandle handle = _FakeHandle();
      final HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        disableEffects: true,
        manifest: PlaybackManifest(
          partyId: 'party-1',
          channelId: hauntedSurveillanceChannelId,
          version: 3,
          publishedAt: DateTime.utc(2026, 10, 31, 20),
          clips: <ClipDescriptor>[
            for (int i = 0; i < 3; i++)
              ClipDescriptor(
                id: 'clip-0$i',
                cameraId: 'CAM-0${i + 1}',
                storageObjectId: 'obj-0$i',
                sha256: _sha,
                sizeBytes: 1024,
                duration: const Duration(seconds: 4),
                mimeType: 'video/mp4',
              ),
            const ClipDescriptor(
              id: 'clip-99',
              cameraId: 'CAM-09',
              storageObjectId: 'obj-99',
              sha256: _sha,
              sizeBytes: 1024,
              duration: Duration(seconds: 4),
              mimeType: 'video/mp4',
              label: 'Rodent Cam',
            ),
          ],
        ),
        tileBuilder: _fakeSurface,
      );
      final ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: handle,
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text('Rodent Cam'), findsNothing);
      for (final CctvSlot slot in cctvSlots) {
        expect(find.text(slot.defaultLabel), findsOneWidget);
      }
    });

    testWidgets('manifest overlay tunes the tile effect intensities', (
      WidgetTester tester,
    ) async {
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

    testWidgets('default wall wires scanline + vignette overlays per tile', (
      WidgetTester tester,
    ) async {
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

    testWidgets('disableEffects removes painters from every tile', (
      WidgetTester tester,
    ) async {
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

    testWidgets(
      'coordinator boot failure degrades to SignalLost, wall survives',
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
      },
    );

    testWidgets('a throwing surface degrades to SignalLost, wall survives', (
      WidgetTester tester,
    ) async {
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

    testWidgets('build applies wall config from ChannelContext.settings', (
      WidgetTester tester,
    ) async {
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

    testWidgets('constructor wall config still applies with empty settings', (
      WidgetTester tester,
    ) async {
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

    testWidgets('settings label overrides win over manifest clip labels', (
      WidgetTester tester,
    ) async {
      // Precedence composition on one wall: the manifest carries a clip
      // label for CAM-01 AND settings carry an override for the same
      // camera — settings win. CAM-03 keeps its manifest label, CAM-02
      // and CAM-04 keep slot defaults.
      final HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        disableEffects: true,
        manifest: _manifest(
          labels: const <String, String?>{
            'CAM-01': 'Manifest Door',
            'CAM-03': 'Manifest Basement',
          },
        ),
        tileBuilder: _fakeSurface,
      );
      final ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: _FakeHandle(),
        settings: const ChannelSettings(<String, Object?>{
          'labels': <String, String>{'CAM-01': 'PORCH · settings'},
        }),
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();

      expect(find.text('PORCH · settings'), findsOneWidget);
      expect(find.text('Manifest Door'), findsNothing);
      expect(find.text('Manifest Basement'), findsOneWidget);
      expect(find.text('CAM-02 · kitchen'), findsOneWidget);
      expect(find.text('CAM-04 · storage room'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    test(
      'cctvLabelOverridesFromSettings filters non-Map/non-string shapes',
      () {
        // No `labels` key at all.
        expect(
          cctvLabelOverridesFromSettings(const ChannelSettings()),
          isEmpty,
        );
        // Non-Map value is ignored, not thrown on.
        expect(
          cctvLabelOverridesFromSettings(
            const ChannelSettings(<String, Object?>{'labels': 'PORCH'}),
          ),
          isEmpty,
        );
        // Non-string keys/values are dropped; only String->String survives.
        expect(
          cctvLabelOverridesFromSettings(
            const ChannelSettings(<String, Object?>{
              'labels': <Object?, Object?>{
                'CAM-01': 'Porch',
                'CAM-02': 42,
                'CAM-03': null,
                7: 'Attic',
              },
            }),
          ),
          <String, String>{'CAM-01': 'Porch'},
        );
      },
    );
  });

  group('cctvCameraCountFromSettings', () {
    ChannelSettings settingsWith(Object? value) => ChannelSettings(
      <String, Object?>{CctvWallSettingsKeys.cameraCount: value},
    );

    test('documented string encoding maps to itself', () {
      expect(cctvCameraCountFromSettings(settingsWith('1')), 1);
      expect(cctvCameraCountFromSettings(settingsWith('2')), 2);
      expect(cctvCameraCountFromSettings(settingsWith('4')), 4);
    });

    test('absent, invalid, and unreadable values default to four', () {
      expect(cctvCameraCountFromSettings(const ChannelSettings()), 4);
      expect(cctvCameraCountFromSettings(settingsWith('3')), 4);
      expect(cctvCameraCountFromSettings(settingsWith('0')), 4);
      expect(cctvCameraCountFromSettings(settingsWith('')), 4);
      expect(cctvCameraCountFromSettings(settingsWith('banana')), 4);
      expect(cctvCameraCountFromSettings(settingsWith('1.5')), 4);
      expect(cctvCameraCountFromSettings(settingsWith(null)), 4);
      expect(cctvCameraCountFromSettings(settingsWith(true)), 4);
      expect(cctvCameraCountFromSettings(settingsWith(3)), 4);
      expect(cctvCameraCountFromSettings(settingsWith(1.0)), 4);
    });

    test('surrounding whitespace is tolerated, raw ints pass through', () {
      expect(cctvCameraCountFromSettings(settingsWith(' 2 ')), 2);
      expect(cctvCameraCountFromSettings(settingsWith(2)), 2);
    });
  });

  group('cctvHeroCameraIdFromSettings', () {
    test('absent and non-string values mean grid', () {
      expect(cctvHeroCameraIdFromSettings(const ChannelSettings()), isNull);
      expect(
        cctvHeroCameraIdFromSettings(
          const ChannelSettings(<String, Object?>{'heroCameraId': ''}),
        ),
        isNull,
      );
      expect(
        cctvHeroCameraIdFromSettings(
          const ChannelSettings(<String, Object?>{'heroCameraId': 42}),
        ),
        isNull,
      );
    });

    test('non-empty strings pass through (wall validates membership)', () {
      expect(
        cctvHeroCameraIdFromSettings(
          ChannelSettings(<String, Object?>{
            CctvWallSettingsKeys.heroCameraId: 'CAM-02',
          }),
        ),
        'CAM-02',
      );
    });
  });

  group('cctvEffectiveCount', () {
    test('is min(configured, manifest clips), always supported', () {
      expect(cctvEffectiveCount(configuredCount: 4, manifestClipCount: 4), 4);
      expect(cctvEffectiveCount(configuredCount: 2, manifestClipCount: 4), 2);
      expect(cctvEffectiveCount(configuredCount: 1, manifestClipCount: 4), 1);
      expect(cctvEffectiveCount(configuredCount: 4, manifestClipCount: 2), 2);
      expect(cctvEffectiveCount(configuredCount: 4, manifestClipCount: 1), 1);
      expect(cctvEffectiveCount(configuredCount: 2, manifestClipCount: 1), 1);
    });

    test('unsupported inputs degrade instead of crashing', () {
      expect(cctvEffectiveCount(configuredCount: 3, manifestClipCount: 4), 4);
      expect(cctvEffectiveCount(configuredCount: 2, manifestClipCount: 3), 2);
    });
  });

  group('adaptive wall layouts', () {
    Future<void> pumpWall(
      WidgetTester tester,
      ChannelSettings settings, {
      PlaybackManifest? manifest,
    }) async {
      final HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        disableEffects: true,
        manifest: manifest,
        tileBuilder: _fakeSurface,
        clock: _FakeClock(DateTime(2026, 10, 31, 20)),
      );
      final ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: _FakeHandle(),
        settings: settings,
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();
    }

    ChannelSettings countSettings(String count) => ChannelSettings(
      <String, Object?>{CctvWallSettingsKeys.cameraCount: count},
    );

    testWidgets('count 1 renders one full-size tile', (
      WidgetTester tester,
    ) async {
      await pumpWall(tester, countSettings('1'));
      expect(find.byKey(const Key('surface-CAM-01')), findsOneWidget);
      for (final String camera in <String>['CAM-02', 'CAM-03', 'CAM-04']) {
        expect(find.byKey(Key('surface-$camera')), findsNothing);
      }
      final Size wall = tester.getSize(find.byKey(kCctvWallKey));
      final Rect tile = tester.getRect(find.byKey(const Key('surface-CAM-01')));
      // Padded single tile: strictly inside the viewport-sized wall, and
      // larger than any single quadrant of the 2x2 grid would be.
      expect(tile.width, greaterThan(wall.width / 2));
      expect(tile.height, greaterThan(wall.height / 2));
      expect(
        Rect.fromLTWH(0, 0, wall.width, wall.height).contains(tile.topLeft) &&
            Rect.fromLTWH(
              0,
              0,
              wall.width,
              wall.height,
            ).contains(tile.bottomRight),
        isTrue,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('count 2 renders two side-by-side tiles in one row', (
      WidgetTester tester,
    ) async {
      await pumpWall(tester, countSettings('2'));
      expect(find.byKey(const Key('surface-CAM-01')), findsOneWidget);
      expect(find.byKey(const Key('surface-CAM-02')), findsOneWidget);
      expect(find.byKey(const Key('surface-CAM-03')), findsNothing);
      expect(find.byKey(const Key('surface-CAM-04')), findsNothing);
      final Rect first = tester.getRect(
        find.byKey(const ValueKey<String>('wall-slot-CAM-01')),
      );
      final Rect second = tester.getRect(
        find.byKey(const ValueKey<String>('wall-slot-CAM-02')),
      );
      // Same row (equal tops), canonical order (CAM-01 left of CAM-02),
      // roughly half the wall each.
      expect(first.top, second.top);
      expect(first.left, lessThan(second.left));
      expect(first.width, closeTo(second.width, 1));
      final Size wall = tester.getSize(find.byKey(kCctvWallKey));
      expect(first.width, closeTo(wall.width / 2, 6));
      expect(tester.takeException(), isNull);
    });

    testWidgets('invalid count defaults to four tiles', (
      WidgetTester tester,
    ) async {
      await pumpWall(tester, countSettings('3'));
      for (final String camera in cctvCameraIds) {
        expect(find.byKey(Key('surface-$camera')), findsOneWidget);
      }
      expect(tester.takeException(), isNull);
    });

    testWidgets('tile builders run for active ids only', (
      WidgetTester tester,
    ) async {
      final List<String> built = <String>[];
      Widget recording(
        BuildContext context,
        int index,
        String label,
        String cameraId,
      ) {
        built.add(cameraId);
        return _fakeSurface(context, index, label, cameraId);
      }

      final HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        disableEffects: true,
        tileBuilder: recording,
        clock: _FakeClock(DateTime(2026, 10, 31, 20)),
      );
      final ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: _FakeHandle(),
        settings: countSettings('2'),
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();
      expect(built, <String>['CAM-01', 'CAM-02']);
    });

    testWidgets('labels and manifest mapping use the active set', (
      WidgetTester tester,
    ) async {
      await pumpWall(
        tester,
        countSettings('2'),
        manifest: _manifest(
          labels: const <String, String?>{
            'CAM-01': 'Front Door',
            'CAM-02': 'Kitchen Cam',
            'CAM-03': 'Basement',
            'CAM-04': 'Vault',
          },
        ),
      );
      expect(find.text('Front Door'), findsOneWidget);
      expect(find.text('Kitchen Cam'), findsOneWidget);
      expect(find.text('Basement'), findsNothing);
      expect(find.text('Vault'), findsNothing);
    });

    testWidgets('a two-clip manifest caps the wall at two tiles', (
      WidgetTester tester,
    ) async {
      PlaybackManifest twoClip() {
        final PlaybackManifest full = _manifest();
        return PlaybackManifest(
          partyId: full.partyId,
          channelId: full.channelId,
          version: full.version,
          publishedAt: full.publishedAt,
          clips: full.clips.take(2).toList(),
        );
      }

      await pumpWall(tester, const ChannelSettings(), manifest: twoClip());
      expect(find.byKey(const Key('surface-CAM-01')), findsOneWidget);
      expect(find.byKey(const Key('surface-CAM-02')), findsOneWidget);
      expect(find.byKey(const Key('surface-CAM-03')), findsNothing);
      expect(find.byKey(const Key('surface-CAM-04')), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'an unsupported-length manifest degrades to per-slot defaults',
      (WidgetTester tester) async {
        PlaybackManifest threeClip() {
          final PlaybackManifest full = _manifest();
          return PlaybackManifest(
            partyId: full.partyId,
            channelId: full.channelId,
            version: full.version,
            publishedAt: full.publishedAt,
            clips: full.clips.take(3).toList(),
          );
        }

        await pumpWall(tester, const ChannelSettings(), manifest: threeClip());
        for (final CctvSlot slot in cctvSlots) {
          expect(find.text(slot.defaultLabel), findsOneWidget);
        }
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('settings count wins; constructor count is the fallback', (
      WidgetTester tester,
    ) async {
      // No settings key: the constructor default (2 here) applies.
      final HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
        disableEffects: true,
        tileBuilder: _fakeSurface,
        clock: _FakeClock(DateTime(2026, 10, 31, 20)),
        cameraCount: 2,
      );
      ChannelContext ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: _FakeHandle(),
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('surface-CAM-03')), findsNothing);

      // Present settings win over the constructor default.
      ctx = ChannelContext(
        partyId: PartyId('party-1'),
        playbackHandle: _FakeHandle(),
        settings: countSettings('4'),
      );
      await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('surface-CAM-03')), findsOneWidget);
    });

    testWidgets('hero animates the existing tile fullscreen, siblings fade', (
      WidgetTester tester,
    ) async {
      Future<void> pumpWithHero(WidgetTester tester, String? hero) async {
        final HauntedSurveillancePlugin plugin = HauntedSurveillancePlugin(
          disableEffects: true,
          tileBuilder: _fakeSurface,
          clock: _FakeClock(DateTime(2026, 10, 31, 20)),
        );
        final ChannelContext ctx = ChannelContext(
          partyId: PartyId('party-1'),
          playbackHandle: _FakeHandle(),
          settings: ChannelSettings(<String, Object?>{
            if (hero != null) CctvWallSettingsKeys.heroCameraId: hero,
          }),
        );
        await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
      }

      await pumpWithHero(tester, null);
      await tester.pumpAndSettle();
      final Rect cell = tester.getRect(
        find.byKey(const ValueKey<String>('wall-slot-CAM-02')),
      );
      final Size wall = tester.getSize(find.byKey(kCctvWallKey));

      await pumpWithHero(tester, 'CAM-02');
      await tester.pump(kWallLayoutDuration ~/ 2);
      final Rect mid = tester.getRect(
        find.byKey(const ValueKey<String>('wall-slot-CAM-02')),
      );
      // Intermediate geometry: strictly between the grid cell and the full
      // viewport rectangle.
      expect(mid.width, greaterThan(cell.width));
      expect(mid.width, lessThan(wall.width));
      expect(mid.height, greaterThan(cell.height));

      await tester.pumpAndSettle();
      final Rect heroRect = tester.getRect(
        find.byKey(const ValueKey<String>('wall-slot-CAM-02')),
      );
      expect(heroRect.left, 0);
      expect(heroRect.top, 0);
      expect(heroRect.width, wall.width);
      expect(heroRect.height, wall.height);
      // Siblings stay mounted (faded, but present) — no decoder churn.
      expect(find.byKey(const Key('surface-CAM-01')), findsOneWidget);
      expect(find.byKey(const Key('surface-CAM-03')), findsOneWidget);
      expect(find.byKey(const Key('surface-CAM-04')), findsOneWidget);
      final Finder faded = find.byWidgetPredicate(
        (Widget w) =>
            w is AnimatedOpacity && w.opacity == 0 && w.child is IgnorePointer,
      );
      expect(faded, findsNWidgets(3));
      expect(tester.takeException(), isNull);
    });

    testWidgets('unknown hero id degrades to the grid', (
      WidgetTester tester,
    ) async {
      await pumpWall(
        tester,
        ChannelSettings(<String, Object?>{
          CctvWallSettingsKeys.heroCameraId: 'CAM-09',
        }),
      );
      for (final String camera in cctvCameraIds) {
        expect(find.byKey(Key('surface-$camera')), findsOneWidget);
      }
      expect(
        find.byWidgetPredicate(
          (Widget w) => w is AnimatedOpacity && w.opacity == 0,
        ),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
    });
  });

  group('port direction (D-08)', () {
    // Finding D-08: channels must be able to consume the control-plane ports
    // without importing `infra_*`. These two tests keep that true from the
    // consumer side: one walks the real import graph, the other compiles and
    // runs fakes implemented purely against `channel_api`.
    test('lib graph of this channel imports no infra_* package', () {
      final Set<String> visitedPackages = <String>{};
      final List<File> sources = _transitiveLibSources(
        Directory.current,
        visitedPackages,
      );
      expect(
        visitedPackages,
        containsAll(<String>['channel_cctv', 'channel_api']),
        reason: 'walk must actually reach the contracts package',
      );
      final List<String> offenders = <String>[
        for (final File f in sources)
          if (f.readAsStringSync().contains('package:infra_')) f.path,
      ];
      expect(
        offenders,
        isEmpty,
        reason: 'channels must not import infra_* (finding D-08)',
      );
    });

    test('ports are implementable from channel_api alone', () async {
      final _ContractOnlyManifestSource source = _ContractOnlyManifestSource(
        _manifest(),
      );
      final ManifestSource<PlaybackManifest> port = source;
      final List<PlaybackManifest> seen = await port
          .watchCurrent(
            partyId: 'party-1',
            channelId: hauntedSurveillanceChannelId,
          )
          .toList();
      expect(seen, hasLength(1));
      expect(seen.single.channelId, hauntedSurveillanceChannelId);

      final SettingsPort settings = _ContractOnlySettings();
      await settings.setString(
        partyId: PartyId('party-1'),
        key: 'label.cam-01',
        value: 'Front Door',
      );
      expect(
        await settings.getString(
          partyId: PartyId('party-1'),
          key: 'label.cam-01',
        ),
        'Front Door',
      );
    });
  });
}

/// Collects the `lib/` sources of [packageRoot] and, transitively, of every
/// sibling path package reachable through `package:<name>/<path>` imports.
///
/// Only local siblings (`<packages>/<name>/lib/*.dart`) are followed, so SDK
/// and pub-cache packages terminate the walk. Names are recorded in
/// [visited] so the caller can assert the graph was not vacuous.
List<File> _transitiveLibSources(Directory packageRoot, Set<String> visited) {
  final List<File> collected = <File>[];
  final List<(String, Directory)> queue = <(String, Directory)>[
    (_packageNameOf(packageRoot), packageRoot),
  ];
  while (queue.isNotEmpty) {
    final (String name, Directory root) = queue.removeLast();
    if (!visited.add(name)) {
      continue;
    }
    final Directory lib = Directory('${root.path}/lib');
    if (!lib.existsSync()) {
      continue;
    }
    for (final File file in lib.listSync(recursive: true).whereType<File>()) {
      if (!file.path.endsWith('.dart')) {
        continue;
      }
      collected.add(file);
      for (final String uri in _packageUrisOf(file.readAsStringSync())) {
        final String target = uri.split('/').first;
        final Directory sibling = Directory(
          '${packageRoot.parent.path}/$target',
        );
        if (sibling.existsSync()) {
          queue.add((target, sibling));
        }
      }
    }
  }
  return collected;
}

/// Package name of [root], read from its `pubspec.yaml` name line.
String _packageNameOf(Directory root) {
  final File pubspec = File('${root.path}/pubspec.yaml');
  for (final String line in pubspec.readAsLinesSync()) {
    if (line.startsWith('name:')) {
      return line.substring('name:'.length).trim();
    }
  }
  return root.uri.pathSegments.where((String s) => s.isNotEmpty).last;
}

/// `package:<name>/<path>` URIs referenced by [source].
Iterable<String> _packageUrisOf(String source) sync* {
  for (final RegExpMatch match in RegExp(
    r'package:([a-z0-9_]+/[A-Za-z0-9_./]+)',
  ).allMatches(source)) {
    yield match.group(1)!;
  }
}

/// Manifest source bound to `PlaybackManifest` using only the contracts port.
final class _ContractOnlyManifestSource
    implements ManifestSource<PlaybackManifest> {
  _ContractOnlyManifestSource(this.manifest);

  final PlaybackManifest manifest;

  @override
  Stream<PlaybackManifest> watchCurrent({
    required String partyId,
    required String channelId,
  }) async* {
    yield manifest;
  }
}

/// Settings store written against the contracts port; no infra adapter used.
final class _ContractOnlySettings implements SettingsPort {
  final Map<String, String> _values = <String, String>{};

  @override
  Future<String?> getString({
    required PartyId partyId,
    required String key,
  }) async => _values['${partyId.value}/$key'];

  @override
  Future<void> setString({
    required PartyId partyId,
    required String key,
    required String value,
  }) async {
    _values['${partyId.value}/$key'] = value;
  }

  @override
  Future<bool?> getBool({
    required PartyId partyId,
    required String key,
  }) async => _values['${partyId.value}/$key'] == 'true';

  @override
  Future<void> setBool({
    required PartyId partyId,
    required String key,
    required bool value,
  }) async {
    _values['${partyId.value}/$key'] = '$value';
  }
}

Widget _fakeSurface(
  BuildContext context,
  int index,
  String label,
  String cameraId,
) => Container(color: Colors.black, key: Key('surface-$cameraId'));

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
