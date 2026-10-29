import 'dart:io';

import 'package:channel_api/channel_api.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

final class _FakeManifest {
  _FakeManifest(this.name);

  final String name;
}

final class _FakeManifestSource implements ManifestSource<_FakeManifest> {
  _FakeManifestSource(this.current);

  _FakeManifest current;

  @override
  Stream<_FakeManifest> watchCurrent({
    required String partyId,
    required String channelId,
  }) async* {
    yield current;
  }
}

final class _FakeSettings implements SettingsPort {
  final Map<String, Map<String, String>> _strings = <String, Map<String, String>>{};
  final Map<String, Map<String, bool>> _bools = <String, Map<String, bool>>{};

  @override
  Future<String?> getString({
    required PartyId partyId,
    required String key,
  }) async => _strings[partyId.value]?[key];

  @override
  Future<void> setString({
    required PartyId partyId,
    required String key,
    required String value,
  }) async {
    (_strings[partyId.value] ??= <String, String>{})[key] = value;
  }

  @override
  Future<bool?> getBool({
    required PartyId partyId,
    required String key,
  }) async => _bools[partyId.value]?[key];

  @override
  Future<void> setBool({
    required PartyId partyId,
    required String key,
    required bool value,
  }) async {
    (_bools[partyId.value] ??= <String, bool>{})[key] = value;
  }
}

final class _Handle implements PlaybackHandle {
  int prepared = 0;
  int activated = 0;

  @override
  Future<void> prepare() async => prepared++;

  @override
  Future<void> activate() async => activated++;
}

final class _Plugin implements ChannelPlugin {
  @override
  final ChannelDescriptor descriptor;

  PlaybackHandle? seenHandle;
  ChannelContext? seenContext;

  _Plugin(this.descriptor);

  @override
  Widget build(ChannelContext context) {
    seenContext = context;
    seenHandle = context.playbackHandle;
    return Text(
      'channel:${descriptor.id}:${context.partyId.value}',
      textDirection: TextDirection.ltr,
    );
  }
}

const ChannelDescriptor _cctv = ChannelDescriptor(
  id: 'cctv',
  title: 'CCTV',
  version: 2,
  capabilities: ChannelCapability(videoPlayback: true, timedEvents: true),
);

void main() {
  group('ChannelDescriptor', () {
    test('round-trips through json with equality', () {
      final back = ChannelDescriptor.fromJson(_cctv.toJson());
      expect(back, equals(_cctv));
      expect(back.id, 'cctv');
      expect(back.title, 'CCTV');
      expect(back.version, 2);
      expect(back.capabilities, _cctv.capabilities);
    });

    test('fromJson defaults capabilities and rejects malformed input', () {
      final bare = ChannelDescriptor.fromJson(<String, Object?>{
        'id': 'retro',
        'title': 'Retro TV',
        'version': 1,
      });
      expect(bare.capabilities, const ChannelCapability());
      expect(bare.capabilities.videoPlayback, isFalse);

      expect(
        () => ChannelDescriptor.fromJson(<String, Object?>{'id': 'x'}),
        throwsFormatException,
      );
      expect(
        () => ChannelDescriptor.fromJson(<String, Object?>{
          'id': 7,
          'title': 'x',
          'version': 1,
        }),
        throwsFormatException,
      );
      expect(
        () => ChannelDescriptor.fromJson(<String, Object?>{
          'id': 'x',
          'title': 'x',
          'version': 1,
          'capabilities': 'nope',
        }),
        throwsFormatException,
      );
    });

    test('rejects blank ids/titles and non-positive versions', () {
      expect(
        () => ChannelDescriptor(id: '', title: 't', version: 1),
        throwsA(isA<AssertionError>()),
      );
      expect(
        () => ChannelDescriptor(id: 'x', title: '', version: 1),
        throwsA(isA<AssertionError>()),
      );
      expect(
        () => ChannelDescriptor(id: 'x', title: 't', version: 0),
        throwsA(isA<AssertionError>()),
      );
    });
  });

  group('ChannelCapability', () {
    test('defaults are all false', () {
      const c = ChannelCapability();
      expect(c.videoPlayback, isFalse);
      expect(c.effects, isFalse);
      expect(c.timedEvents, isFalse);
      expect(c.guestMedia, isFalse);
    });

    test('round-trips all true flags', () {
      const all = ChannelCapability(
        videoPlayback: true,
        effects: true,
        timedEvents: true,
        guestMedia: true,
      );
      final back = ChannelCapability.fromJson(all.toJson());
      expect(back, equals(all));
      expect(back.hashCode, all.hashCode);
      expect(back.toJson().values.every((v) => v == true), isTrue);
    });
  });

  group('ChannelSettings', () {
    test('typed get falls back on absent or wrong-typed values', () {
      const settings = ChannelSettings({'quality': 'high', 'volume': 3});
      expect(settings.get('quality', 'low'), 'high');
      expect(settings.get('missing', 'low'), 'low');
      expect(settings.get('volume', 0), 3);
      expect(settings.get<int>('quality', 0), 0);
      expect(settings.isEmpty, isFalse);
      expect(const ChannelSettings().isEmpty, isTrue);
    });

    test('compares by value and serialises a copy', () {
      const a = ChannelSettings({'x': 1});
      const b = ChannelSettings({'x': 1});
      expect(a, equals(b));
      expect(a, isNot(equals(const ChannelSettings({'x': 2}))));
      final json = a.toJson();
      json['x'] = 99;
      expect(a.get('x', 0), 1);
    });
  });

  group('ChannelPlugin', () {
    test('build receives party, handle and settings; handle stays opaque', () {
      final plugin = _Plugin(_cctv);
      final handle = _Handle();
      final ctx = ChannelContext(
        partyId: PartyId('party-9'),
        playbackHandle: handle,
        settings: const ChannelSettings({'quality': 'high'}),
      );
      final w = plugin.build(ctx) as Text;
      expect(w.data, 'channel:cctv:party-9');
      expect(plugin.seenHandle, same(handle));
      expect(plugin.seenContext!.settings.get('quality', 'low'), 'high');
      expect(plugin.seenContext!.partyId, PartyId('party-9'));
    });

    testWidgets('built widget renders in a widget tree', (tester) async {
      final plugin = _Plugin(_cctv);
      await tester.pumpWidget(
        plugin.build(
          ChannelContext(
            partyId: PartyId('party-1'),
            playbackHandle: _Handle(),
          ),
        ),
      );
      expect(find.text('channel:cctv:party-1'), findsOneWidget);
    });

    test('PlaybackHandle exposes prepare/activate futures', () async {
      final handle = _Handle();
      await handle.prepare();
      await handle.activate();
      expect(handle.prepared, 1);
      expect(handle.activated, 1);
    });
  });

  group('ManifestSource port (contracts layer)', () {
    test('streams the current manifest per subscription', () async {
      ManifestSource<_FakeManifest> source = _FakeManifestSource(
        _FakeManifest('v1'),
      );
      final List<_FakeManifest> first = await source
          .watchCurrent(partyId: 'party-1', channelId: 'cctv')
          .toList();
      expect(first.map((m) => m.name).toList(), <String>['v1']);
      // A new publication is observed by later subscribers.
      source = _FakeManifestSource(_FakeManifest('v2'));
      final List<_FakeManifest> second = await source
          .watchCurrent(partyId: 'party-1', channelId: 'cctv')
          .toList();
      expect(second.map((m) => m.name).toList(), <String>['v2']);
    });
  });

  group('SettingsPort (contracts layer)', () {
    test('round-trips strings and bools scoped by party', () async {
      final SettingsPort settings = _FakeSettings();
      final PartyId partyA = PartyId('party-a');
      final PartyId partyB = PartyId('party-b');
      expect(
        await settings.getString(partyId: partyA, key: 'theme'),
        isNull,
      );
      await settings.setString(
        partyId: partyA,
        key: 'theme',
        value: 'spooky',
      );
      expect(
        await settings.getString(partyId: partyA, key: 'theme'),
        'spooky',
      );
      // Party scoping: party B sees nothing of party A's keys.
      expect(
        await settings.getString(partyId: partyB, key: 'theme'),
        isNull,
      );
      await settings.setBool(partyId: partyA, key: 'muted', value: true);
      expect(await settings.getBool(partyId: partyA, key: 'muted'), isTrue);
      expect(await settings.getBool(partyId: partyA, key: 'missing'), isNull);
    });
  });

  group('port direction (D-08)', () {
    // Intentionally grep-level (per the partition brief): the contracts
    // layer must never import `infra_*` — channels consume ports from here,
    // and a single infra import in lib/ would drag the wrong direction back
    // in. This runs from the package root under `flutter test`, where
    // `lib/` resolves to this package's contracts sources.
    test('contracts lib/ contains no infra imports', () {
      final Directory libDir = Directory('lib');
      expect(
        libDir.existsSync(),
        isTrue,
        reason: 'expected to run from the channel_api package root',
      );
      final List<File> sources = libDir
          .listSync(recursive: true)
          .whereType<File>()
          .where((f) => f.path.endsWith('.dart'))
          .toList();
      expect(sources, isNotEmpty);
      final List<String> offenders = <String>[
        for (final File f in sources)
          if (f.readAsStringSync().contains('package:infra_')) f.path,
      ];
      expect(
        offenders,
        isEmpty,
        reason:
            'channel_api (contracts) must not import infra_* packages (D-08)',
      );
    });
  });
}
