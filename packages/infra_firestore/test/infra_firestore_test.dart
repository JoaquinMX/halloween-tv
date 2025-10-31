import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:infra_firestore/infra_firestore.dart';

void main() {
  test('maps firestore document to playlist', () async {
    final fake = FakeFirebaseFirestore();
    await fake.collection('parties').doc('party').collection('playlist').doc('current').set({
      'version': 2,
      'expiresAt': DateTime.parse('2030-01-01T00:00:00Z'),
      'overlay': {'timestampFmt': 'yyyy-MM-dd HH:mm:ss', 'glitchIntensity': 0.3},
      'clips': List.generate(4, (index) {
        return {
          'id': 'clip$index',
          'label': 'CAM-0$index',
          'localKey': 'cam$index_v2.mp4',
          'signedUrl': 'https://example.com/$index',
          'checksumSha256': 'hash$index',
          'sizeBytes': 1024,
        };
      }),
    });

    final adapter = FirestorePlaylistAdapter(firestore: fake);
    final playlist = await adapter.watchCurrent('party').first;

    expect(playlist.version, 2);
    expect(playlist.clips, hasLength(4));
    expect(playlist.overlay.timestampFmt, 'yyyy-MM-dd HH:mm:ss');
  });
}
