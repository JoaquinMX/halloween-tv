import 'package:core_foundation/core_foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_settings/infra_settings.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
  });

  test('string and bool settings survive a new adapter instance', () async {
    final PartyId party = PartyId('party-1');
    final SharedPreferencesSettings first = SharedPreferencesSettings();
    await first.setString(partyId: party, key: 'theme', value: 'spooky');
    await first.setBool(partyId: party, key: 'muted', value: true);

    final SharedPreferencesSettings reopened = SharedPreferencesSettings();
    expect(await reopened.getString(partyId: party, key: 'theme'), 'spooky');
    expect(await reopened.getBool(partyId: party, key: 'muted'), isTrue);
  });

  test(
    'migrates values from an InMemorySettings fallback into preferences',
    () async {
      final PartyId party = PartyId('party-legacy');
      final InMemorySettings legacy = InMemorySettings();
      await legacy.setString(partyId: party, key: 'scene', value: 'haunted');
      await legacy.setBool(partyId: party, key: 'effects', value: false);
      final SharedPreferencesSettings migrating = SharedPreferencesSettings(
        fallback: legacy,
      );

      expect(
        await migrating.getString(partyId: party, key: 'scene'),
        'haunted',
      );
      expect(await migrating.getBool(partyId: party, key: 'effects'), isFalse);

      final SharedPreferencesSettings reopened = SharedPreferencesSettings();
      expect(await reopened.getString(partyId: party, key: 'scene'), 'haunted');
      expect(await reopened.getBool(partyId: party, key: 'effects'), isFalse);
    },
  );

  test('keeps party and value type namespaces independent', () async {
    final SharedPreferencesSettings settings = SharedPreferencesSettings();
    await settings.setString(
      partyId: PartyId('party-a'),
      key: 'shared',
      value: 'left',
    );
    await settings.setBool(
      partyId: PartyId('party-a'),
      key: 'shared',
      value: true,
    );

    expect(
      await settings.getString(partyId: PartyId('party-a'), key: 'shared'),
      'left',
    );
    expect(
      await settings.getBool(partyId: PartyId('party-a'), key: 'shared'),
      isTrue,
    );
    expect(
      await settings.getString(partyId: PartyId('party-b'), key: 'shared'),
      isNull,
    );
  });
}
