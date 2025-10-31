import 'package:flutter_test/flutter_test.dart';

import 'package:channel_cctv/channel_cctv.dart';

void main() {
  test('descriptor contains expected id', () {
    expect(ChannelCctvPlugin().descriptor.id, 'surveillance.cctv');
  });
}
