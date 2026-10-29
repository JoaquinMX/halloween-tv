import 'package:channel_api/channel_api.dart';
import 'package:channel_retro_tv/channel_retro_tv.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('retro descriptor is valid and wall-safe', () {
    const RetroHorrorPlugin plugin = RetroHorrorPlugin();
    expect(plugin.descriptor.id, retroHorrorChannelId);
    expect(plugin.descriptor.id, 'retro_horror');
    expect(plugin.descriptor.title, isNotEmpty);
    expect(plugin.descriptor.version, greaterThan(0));
  });

  testWidgets('builds a placeholder page without breaking',
      (WidgetTester tester) async {
    const RetroHorrorPlugin plugin = RetroHorrorPlugin();
    final ChannelContext ctx = ChannelContext(
      partyId: PartyId('party-1'),
      playbackHandle: _Handle(),
    );
    await tester.pumpWidget(MaterialApp(home: plugin.build(ctx)));
    expect(find.textContaining('Retro Horror'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

final class _Handle implements PlaybackHandle {
  @override
  Future<void> prepare() async {}

  @override
  Future<void> activate() async {}
}
