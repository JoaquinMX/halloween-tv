import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:channel_api/channel_api.dart';

class _FakePlugin implements ChannelPlugin {
  @override
  ChannelDescriptor get descriptor => const ChannelDescriptor('id', 'name', '1.0.0');

  bool built = false;

  @override
  Widget buildEntry(ChannelContext context) {
    built = true;
    expect(context.partyId, 'party');
    return const SizedBox();
  }
}

void main() {
  testWidgets('channel plugin builds with provided context', (WidgetTester tester) async {
    final plugin = _FakePlugin();
    final context = ChannelContext(
      playlistPort: throw UnimplementedError(),
      mediaFetchPort: throw UnimplementedError(),
      cachePort: throw UnimplementedError(),
      effectsEngine: throw UnimplementedError(),
      settingsPort: throw UnimplementedError(),
      partyId: 'party',
    );

    await tester.pumpWidget(Directionality(textDirection: TextDirection.ltr, child: plugin.buildEntry(context)));
    expect(plugin.built, isTrue);
  });
}
