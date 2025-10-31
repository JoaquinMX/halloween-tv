import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:testing_toolkit/testing_toolkit.dart';

void main() {
  test('FakeCachePort stores seeded bytes', () async {
    final cache = FakeCachePort();
    final media = FakeMediaFetchPort(cache);
    final data = Uint8List.fromList(<int>[1, 2, 3]);
    media.seed('clip', data);

    final file = await media.prefetch(
      const ClipRef(localKey: 'clip', signedUrl: '', sizeBytes: 3),
      checksum: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
    );
    expect(await file.file.length(), data.length);
  });
}
