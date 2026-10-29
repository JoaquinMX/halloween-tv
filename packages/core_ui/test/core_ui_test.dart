import 'package:core_effects/core_effects.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:core_ui/core_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

final class _FakeClock implements Clock {
  _FakeClock(this.current);

  DateTime current;

  @override
  DateTime now() => current;
}

void main() {
  group('HudOverlay', () {
    testWidgets('renders label, REC and timestamp', (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: HudOverlay(
            label: 'CAM-01',
            timestamp: DateTime(2026, 10, 31, 20, 0, 0),
            recBlink: false,
          ),
        ),
      );
      expect(find.text('CAM-01'), findsOneWidget);
      expect(find.text('REC'), findsOneWidget);
      expect(find.text('20:00:00'), findsOneWidget);
    });

    testWidgets('hides REC indicator when rec is false',
        (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: HudOverlay(
            label: 'CAM-02',
            rec: false,
            timestamp: DateTime(2026, 10, 31, 21, 30, 5),
            recBlink: false,
          ),
        ),
      );
      expect(find.text('REC'), findsNothing);
      expect(find.text('CAM-02'), findsOneWidget);
      expect(find.text('21:30:05'), findsOneWidget);
    });

    testWidgets('ticks forward with an injected clock',
        (WidgetTester tester) async {
      final _FakeClock clock = _FakeClock(DateTime(2026, 10, 31, 20));
      await tester.pumpWidget(
        MaterialApp(home: HudOverlay(label: 'CAM-03', clock: clock)),
      );
      expect(find.text('20:00:00'), findsOneWidget);
      clock.current = clock.current.add(const Duration(seconds: 65));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('20:01:05'), findsOneWidget);
    });

    testWidgets('survives REC blinking without crashing',
        (WidgetTester tester) async {
      await tester.pumpWidget(
        const MaterialApp(home: HudOverlay(label: 'CAM-04')),
      );
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('REC'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('120-char label at 960x540 neither overflows nor wraps',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(960, 540);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final String longLabel = List<String>.filled(120, 'A').join();
      expect(longLabel, hasLength(120));
      await tester.pumpWidget(
        MaterialApp(
          home: HudOverlay(
            label: longLabel,
            timestamp: DateTime(2026, 10, 31, 20),
            recBlink: false,
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      final Text label = tester.widget<Text>(find.text(longLabel));
      expect(label.maxLines, 1);
      expect(label.overflow, TextOverflow.ellipsis);
    });
  });

  group('CctvTile', () {
    testWidgets('shows SignalLost on error flag and hides the surface',
        (WidgetTester tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: CctvTile(
            hasError: true,
            child: Text('SURFACE', textDirection: TextDirection.ltr),
          ),
        ),
      );
      expect(find.text('SIGNAL LOST'), findsOneWidget);
      expect(find.text('SURFACE'), findsNothing);
    });

    testWidgets('shows child, hud and effects when healthy',
        (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: CctvTile(
            hud: HudOverlay(
              label: 'CAM-01',
              timestamp: DateTime(2026, 10, 31, 20),
              recBlink: false,
            ),
            effectOverlay: const Text('FX'),
            child: Container(key: const Key('surface')),
          ),
        ),
      );
      expect(find.byKey(const Key('surface')), findsOneWidget);
      expect(find.text('CAM-01'), findsOneWidget);
      expect(find.text('FX'), findsOneWidget);
    });

    testWidgets('disableEffects drops the effect overlay slot',
        (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: CctvTile(
            disableEffects: true,
            effectOverlay: const Text('FX'),
            child: Container(key: const Key('surface')),
          ),
        ),
      );
      expect(find.byKey(const Key('surface')), findsOneWidget);
      expect(find.text('FX'), findsNothing);
    });
  });

  group('CctvEffectsOverlay', () {
    Finder painterOf<T extends CustomPainter>() => find.byWidgetPredicate(
          (Widget w) => w is CustomPaint && w.painter is T,
        );

    testWidgets('paints scanlines and vignette for cctvProfile',
        (WidgetTester tester) async {
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: SizedBox(
            width: 200,
            height: 200,
            child: CctvEffectsOverlay(profile: cctvProfile()),
          ),
        ),
      );
      expect(painterOf<ScanlinesPainter>(), findsOneWidget);
      expect(painterOf<VignettePainter>(), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('disableEffects paints nothing', (WidgetTester tester) async {
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: SizedBox(
            width: 200,
            height: 200,
            child: CctvEffectsOverlay(
              profile: cctvProfile(),
              disableEffects: true,
            ),
          ),
        ),
      );
      expect(painterOf<ScanlinesPainter>(), findsNothing);
      expect(painterOf<VignettePainter>(), findsNothing);
      expect(find.byType(ColoredBox), findsNothing);
    });

    testWidgets('glitch intensity adds bounded grain on top of profile',
        (WidgetTester tester) async {
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: SizedBox(
            width: 200,
            height: 200,
            child: CctvEffectsOverlay(
              profile: cctvProfile(),
              glitchIntensity: 0.9,
            ),
          ),
        ),
      );
      final ColoredBox grain = tester.widget<ColoredBox>(find.byType(ColoredBox));
      final double alpha = grain.color.a;
      expect(alpha, greaterThan(0.03));
      expect(alpha, lessThanOrEqualTo(0.11));
    });

    testWidgets('empty profile paints nothing', (WidgetTester tester) async {
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: SizedBox(
            width: 200,
            height: 200,
            child: CctvEffectsOverlay(
              profile: const EffectProfile(<EffectSpec>[]),
            ),
          ),
        ),
      );
      expect(painterOf<ScanlinesPainter>(), findsNothing);
      expect(painterOf<VignettePainter>(), findsNothing);
    });
  });

  group('CctvTheme', () {
    test('uses dark gutters and high-contrast large text', () {
      expect(CctvTheme.gutter, Colors.black);
      expect(CctvTheme.labelStyle.color, Colors.white);
      expect(CctvTheme.labelStyle.fontSize, greaterThanOrEqualTo(24));
      expect(CctvTheme.timestampStyle.color, Colors.white);
      expect(CctvTheme.dark().scaffoldBackgroundColor, Colors.black);
    });
  });
}
