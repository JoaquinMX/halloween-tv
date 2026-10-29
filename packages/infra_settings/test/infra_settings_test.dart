import 'package:core_foundation/core_foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_settings/infra_settings.dart';

void main() {
  group('InMemorySettings string round-trip', () {
    test('unset key reads null, then round-trips the written value', () async {
      final SettingsPort settings = InMemorySettings();
      final party = PartyId('party-1');

      expect(await settings.getString(partyId: party, key: 'theme'), isNull);

      await settings.setString(partyId: party, key: 'theme', value: 'spooky');

      expect(await settings.getString(partyId: party, key: 'theme'), 'spooky');
    });

    test('overwrite replaces the previous value', () async {
      final SettingsPort settings = InMemorySettings();
      final party = PartyId('party-1');

      await settings.setString(partyId: party, key: 'theme', value: 'spooky');
      await settings.setString(partyId: party, key: 'theme', value: 'retro');

      expect(await settings.getString(partyId: party, key: 'theme'), 'retro');
    });
  });

  group('InMemorySettings bool round-trip', () {
    test('unset key reads null, then round-trips true and false', () async {
      final SettingsPort settings = InMemorySettings();
      final party = PartyId('party-1');

      expect(await settings.getBool(partyId: party, key: 'muted'), isNull);

      await settings.setBool(partyId: party, key: 'muted', value: true);
      expect(await settings.getBool(partyId: party, key: 'muted'), isTrue);

      await settings.setBool(partyId: party, key: 'muted', value: false);
      expect(await settings.getBool(partyId: party, key: 'muted'), isFalse);
    });
  });

  group('party scoping', () {
    test('equal PartyId values share a bucket', () async {
      final SettingsPort settings = InMemorySettings();

      await settings.setString(
        partyId: PartyId('party-1'),
        key: 'theme',
        value: 'spooky',
      );

      expect(
        await settings.getString(partyId: PartyId('party-1'), key: 'theme'),
        'spooky',
      );
    });

    test('same key under different parties stays independent', () async {
      final SettingsPort settings = InMemorySettings();
      final one = PartyId('party-1');
      final two = PartyId('party-2');

      await settings.setString(partyId: one, key: 'theme', value: 'spooky');
      await settings.setString(partyId: two, key: 'theme', value: 'retro');

      expect(await settings.getString(partyId: one, key: 'theme'), 'spooky');
      expect(await settings.getString(partyId: two, key: 'theme'), 'retro');
    });

    test('bool keys are party-isolated too', () async {
      final SettingsPort settings = InMemorySettings();

      await settings.setBool(
        partyId: PartyId('party-1'),
        key: 'muted',
        value: true,
      );

      expect(
        await settings.getBool(partyId: PartyId('party-2'), key: 'muted'),
        isNull,
      );
    });
  });

  group('type isolation', () {
    test('string and bool values under the same key do not collide', () async {
      final SettingsPort settings = InMemorySettings();
      final party = PartyId('party-1');

      await settings.setString(partyId: party, key: 'shared', value: 'x');
      expect(await settings.getBool(partyId: party, key: 'shared'), isNull);

      await settings.setBool(partyId: party, key: 'shared', value: true);
      expect(await settings.getString(partyId: party, key: 'shared'), 'x');
      expect(await settings.getBool(partyId: party, key: 'shared'), isTrue);
    });
  });

  group('argument validation', () {
    test('empty key is rejected on read and write', () async {
      final SettingsPort settings = InMemorySettings();
      final party = PartyId('party-1');

      expect(
        () => settings.getString(partyId: party, key: ' '),
        throwsArgumentError,
      );
      expect(
        () => settings.setBool(partyId: party, key: '', value: true),
        throwsArgumentError,
      );
    });
  });
}
