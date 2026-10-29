import 'package:core_foundation/core_foundation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Result', () {
    test('Ok carries value and maps', () {
      const r = Ok<int>(2);
      expect(r.isOk, isTrue);
      expect(r.isErr, isFalse);
      final mapped = r.map((v) => v * 3);
      expect(mapped, isA<Ok<int>>());
      expect((mapped as Ok<int>).value, 6);
    });

    test('Err carries message and map propagates it without invoking fn', () {
      var calls = 0;
      const Result<int> r = Err<int>('boom');
      expect(r.isErr, isTrue);
      expect(r.isOk, isFalse);
      final mapped = r.map((v) {
        calls++;
        return v + 1;
      });
      expect(mapped, isA<Err<int>>());
      expect((mapped as Err<int>).message, 'boom');
      expect(calls, 0);
    });

    test('Result propagation through fallible pipeline', () {
      Result<int> parse(String s) {
        final v = int.tryParse(s);
        if (v == null) {
          return Err<int>('not a number: $s');
        }
        return Ok<int>(v);
      }

      final ok = parse('21').map((v) => v * 2);
      expect((ok as Ok<int>).value, 42);

      final err = parse('nope').map((v) => v * 2);
      expect(err, isA<Err<int>>());
      expect((err as Err<int>).message, contains('not a number'));
    });

    test('sealed Result is exhaustively switchable', () {
      String describe(Result<String> r) => switch (r) {
        Ok(:final value) => 'ok:$value',
        Err(:final message) => 'err:$message',
      };
      expect(describe(const Ok<String>('x')), 'ok:x');
      expect(describe(const Err<String>('bad')), 'err:bad');
    });
  });

  group('value types', () {
    test('PartyId/DeviceId reject blank values and compare by value', () {
      expect(() => PartyId(''), throwsArgumentError);
      expect(() => PartyId('   '), throwsArgumentError);
      expect(() => DeviceId(''), throwsArgumentError);
      expect(() => DeviceId('\t'), throwsArgumentError);

      expect(PartyId('a'), equals(PartyId('a')));
      expect(PartyId('a'), isNot(equals(PartyId('b'))));
      expect(DeviceId('d1'), equals(DeviceId('d1')));
      expect(DeviceId('d1'), isNot(equals(DeviceId('d2'))));
      expect(PartyId('x').hashCode, PartyId('x').hashCode);
    });

    test('PartyId and DeviceId are distinct types', () {
      final party = PartyId('same');
      final device = DeviceId('same');
      expect(party, isNot(equals(device)));
      expect(party.toString(), 'PartyId(same)');
      expect(device.toString(), 'DeviceId(same)');
    });
  });

  group('Clock', () {
    test('SystemClock returns real, non-decreasing time', () async {
      const clock = SystemClock();
      final t0 = clock.now();
      await Future<void>.delayed(const Duration(milliseconds: 5));
      final t1 = clock.now();
      expect(t1.isBefore(t0), isFalse);
      expect(t1.difference(t0), greaterThanOrEqualTo(Duration.zero));
    });
  });
}
