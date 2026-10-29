import 'package:core_effects/core_effects.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('EffectSpec', () {
    test('accepts boundary intensities 0 and 1', () {
      expect(const EffectSpec(EffectType.noise, 0).intensity, 0);
      expect(const EffectSpec(EffectType.noise, 1).intensity, 1);
    });

    test('rejects out-of-range intensities', () {
      expect(() => EffectSpec(EffectType.noise, -0.1),
          throwsA(isA<AssertionError>()));
      expect(() => EffectSpec(EffectType.noise, 1.1),
          throwsA(isA<AssertionError>()));
    });

    test('equality is by type and intensity', () {
      expect(const EffectSpec(EffectType.vignette, 0.2),
          const EffectSpec(EffectType.vignette, 0.2));
      expect(const EffectSpec(EffectType.vignette, 0.2),
          isNot(const EffectSpec(EffectType.vignette, 0.3)));
    });
  });

  group('cctvProfile', () {
    test('is mild scanlines + light vignette + light noise, nothing else',
        () {
      final EffectProfile profile = cctvProfile();
      expect(profile.has(EffectType.scanlines), isTrue);
      expect(profile.has(EffectType.vignette), isTrue);
      expect(profile.has(EffectType.noise), isTrue);
      expect(profile.has(EffectType.rgbSplit), isFalse);
      expect(profile.has(EffectType.signalLoss), isFalse);
      for (final EffectSpec spec in profile.effects) {
        expect(spec.intensity, greaterThan(0));
        expect(spec.intensity, lessThanOrEqualTo(0.35));
      }
    });
  });

  group('retroProfile', () {
    test('is heavier than cctv and adds rgb split', () {
      final EffectProfile retro = retroProfile();
      final EffectProfile cctv = cctvProfile();
      expect(retro.has(EffectType.rgbSplit), isTrue);
      expect(retro.intensityOf(EffectType.scanlines),
          greaterThan(cctv.intensityOf(EffectType.scanlines)));
      expect(retro.intensityOf(EffectType.vignette),
          greaterThan(cctv.intensityOf(EffectType.vignette)));
      expect(retro.intensityOf(EffectType.noise),
          greaterThan(cctv.intensityOf(EffectType.noise)));
    });
  });

  group('EffectProfile', () {
    test('intensityOf missing type is 0', () {
      const EffectProfile profile =
          EffectProfile(<EffectSpec>[EffectSpec(EffectType.noise, 0.2)]);
      expect(profile.intensityOf(EffectType.scanlines), 0);
      expect(profile.has(EffectType.scanlines), isFalse);
    });
  });

  group('painters', () {
    test('ScanlinesPainter is const and repaints only on field change', () {
      const ScanlinesPainter a = ScanlinesPainter();
      const ScanlinesPainter same = ScanlinesPainter();
      expect(a.shouldRepaint(same), isFalse);
      expect(a.shouldRepaint(const ScanlinesPainter(opacity: 0.5)), isTrue);
      expect(
          a.shouldRepaint(const ScanlinesPainter(gap: 8)), isTrue);
    });

    test('VignettePainter is const and repaints only on strength change',
        () {
      const VignettePainter a = VignettePainter();
      expect(a.shouldRepaint(const VignettePainter()), isFalse);
      expect(a.shouldRepaint(const VignettePainter(strength: 0.9)), isTrue);
    });

    testWidgets('painters run without crashing on a real canvas',
        (WidgetTester tester) async {
      await tester.pumpWidget(
        const Directionality(
          textDirection: TextDirection.ltr,
          child: SizedBox(
            width: 64,
            height: 64,
            child: CustomPaint(painter: ScanlinesPainter()),
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(
        const Directionality(
          textDirection: TextDirection.ltr,
          child: SizedBox(
            width: 64,
            height: 64,
            child: CustomPaint(painter: VignettePainter(strength: 0.8)),
          ),
        ),
      );
      expect(tester.takeException(), isNull);
    });
  });

  group('GlitchController', () {
    List<double> run(int seed, {double max = 0.6, double p = 0.5}) {
      final GlitchController c =
          GlitchController(seed: seed, maxIntensity: max, glitchProbability: p);
      final List<double> out = <double>[];
      for (int i = 0; i < 40; i++) {
        c.tick();
        out.add(c.currentIntensity);
      }
      c.dispose();
      return out;
    }

    test('same seed produces identical sequences', () {
      expect(run(1234), run(1234));
    });

    test('different seeds diverge (seed actually drives the sequence)', () {
      expect(run(1234), isNot(run(4321)));
    });

    test('production default is infrequent: mostly quiet per tile', () {
      const int ticks = 400;
      final GlitchController c = GlitchController(seed: 99);
      int active = 0;
      for (int i = 0; i < ticks; i++) {
        c.tick();
        if (c.glitching) {
          active++;
        }
      }
      c.dispose();
      // Default glitchProbability is 0.08 -> ~8% of ticks, never constant.
      expect(active, greaterThan(0));
      expect(active, lessThan(ticks ~/ 4));
    });

    test('intensities stay within 0..maxIntensity', () {
      for (final double v in run(7, max: 0.4)) {
        expect(v, greaterThanOrEqualTo(0));
        expect(v, lessThanOrEqualTo(0.4));
      }
    });

    test('zero probability never glitches', () {
      final GlitchController c =
          GlitchController(seed: 1, glitchProbability: 0);
      for (int i = 0; i < 10; i++) {
        c.tick();
        expect(c.currentIntensity, 0);
        expect(c.glitching, isFalse);
      }
      c.dispose();
    });

    test('reset clears an active glitch', () {
      final GlitchController c =
          GlitchController(seed: 2, glitchProbability: 1);
      c.tick();
      expect(c.glitching, isTrue);
      c.reset();
      expect(c.glitching, isFalse);
      expect(c.currentIntensity, 0);
      c.dispose();
    });
  });
}
