import 'package:flutter_test/flutter_test.dart';

import 'package:channel_retro_tv/channel_retro_tv.dart';

void main() {
  test('descriptor matches retro channel', () {
    expect(const RetroTvChannelPlugin().descriptor.id, 'retro.tv');
  });
}
