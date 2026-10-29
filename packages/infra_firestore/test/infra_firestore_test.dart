import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_firestore/infra_firestore.dart';

const String _shaA =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const String _shaB =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const String _shaC =
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const String _shaD =
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

/// Versioned control-plane document shaped like the Firestore fixture the
/// production snapshot listener receives (envelope `schemaVersion` + the
/// `PlaybackManifest.toJson` payload).
Map<String, Object?> versionedFixture({Object? schemaVersion = 1}) => {
  'schemaVersion': schemaVersion,
  'partyId': 'party-1',
  'channelId': 'cctv',
  'version': 1,
  'publishedAt': '2026-10-29T00:00:00.000Z',
  'overlay': {'scanlineOpacity': 0.5, 'noiseLevel': 0.2, 'vignette': 0.6},
  'clips': [
    {
      'id': 'clip-1',
      'cameraId': 'CAM-01',
      'storageObjectId': 'cctv/cam-01.mp4',
      'sha256': _shaA,
      'sizeBytes': 1024,
      'durationMs': 8000,
      'mimeType': 'video/mp4',
    },
    {
      'id': 'clip-2',
      'cameraId': 'CAM-02',
      'storageObjectId': 'cctv/cam-02.mp4',
      'sha256': _shaB,
      'sizeBytes': 2048,
      'durationMs': 8000,
      'mimeType': 'video/mp4',
    },
    {
      'id': 'clip-3',
      'cameraId': 'CAM-03',
      'storageObjectId': 'cctv/cam-03.mp4',
      'sha256': _shaC,
      'sizeBytes': 3072,
      'durationMs': 8000,
      'mimeType': 'video/mp4',
    },
    {
      'id': 'clip-4',
      'cameraId': 'CAM-04',
      'storageObjectId': 'cctv/cam-04.mp4',
      'sha256': _shaD,
      'sizeBytes': 4096,
      'durationMs': 8000,
      'mimeType': 'video/mp4',
    },
  ],
};

void main() {
  group('manifestFromFirestore', () {
    test('maps a versioned document into a domain manifest', () {
      final manifest = manifestFromFirestore(versionedFixture());

      expect(manifest.partyId, 'party-1');
      expect(manifest.channelId, 'cctv');
      expect(manifest.version, 1);
      expect(manifest.clips, hasLength(4));
      expect(manifest.clips.map((c) => c.cameraId), [
        'CAM-01',
        'CAM-02',
        'CAM-03',
        'CAM-04',
      ]);

      final first = manifest.clips.first;
      expect(first.id, 'clip-1');
      expect(first.storageObjectId, 'cctv/cam-01.mp4');
      expect(first.sha256, _shaA);
      expect(first.sizeBytes, 1024);
      expect(first.duration, const Duration(seconds: 8));
      expect(first.mimeType, 'video/mp4');

      expect(manifest.overlay.scanlineOpacity, 0.5);
      expect(manifest.overlay.noiseLevel, 0.2);
      expect(manifest.overlay.vignette, 0.6);
      expect(manifest.publishedAt, DateTime.utc(2026, 10, 29));
    });

    test('mapped manifest passes core CCTV validation', () {
      final manifest = manifestFromFirestore(versionedFixture());

      final Result<PlaybackManifest> validated = validateCctvManifest(manifest);

      expect(
        validated.isOk,
        isTrue,
        reason: validated.isErr
            ? (validated as Err<PlaybackManifest>).message
            : null,
      );
      expect((validated as Ok<PlaybackManifest>).value, manifest);
    });

    test('does not mutate the input document', () {
      final doc = versionedFixture();
      final keysBefore = doc.keys.toList();

      manifestFromFirestore(doc);

      expect(doc.containsKey('schemaVersion'), isTrue);
      expect(doc.keys.toList(), keysBefore);
    });

    group('schemaVersion tolerance', () {
      for (final version in <Object?>[1, 1.0, '1', ' 1 ']) {
        test('accepts ${version.runtimeType} $version', () {
          final manifest = manifestFromFirestore(
            versionedFixture(schemaVersion: version),
          );
          expect(manifest.clips, hasLength(4));
        });
      }

      for (final version in <Object?>[2, 0, -1, 1.5, 'v1', '', true, null]) {
        test('rejects ${version.runtimeType} $version', () {
          expect(
            () =>
                manifestFromFirestore(versionedFixture(schemaVersion: version)),
            throwsA(isA<ManifestSchemaException>()),
          );
        });
      }

      test('rejects a missing schemaVersion', () {
        final doc = versionedFixture()..remove('schemaVersion');
        expect(
          () => manifestFromFirestore(doc),
          throwsA(isA<ManifestSchemaException>()),
        );
      });

      test('names the offending version in the error', () {
        expect(
          () => manifestFromFirestore(versionedFixture(schemaVersion: 2)),
          throwsA(
            isA<ManifestSchemaException>().having(
              (e) => e.message,
              'message',
              contains('unsupported schemaVersion: 2'),
            ),
          ),
        );
      });
    });

    test('ignores unknown top-level and clip fields', () {
      final doc = versionedFixture()
        ..['publishedBy'] = 'ghost'
        ..['futureField'] = {'nested': true};
      final clips = doc['clips']! as List<Object?>;
      (clips.first! as Map<String, Object?>)['director'] = 'nobody';

      final manifest = manifestFromFirestore(doc);

      expect(manifest.clips, hasLength(4));
      expect(manifest.clips.first.sha256, _shaA);
    });

    test('defaults overlay when the document omits it', () {
      final doc = versionedFixture()..remove('overlay');

      final manifest = manifestFromFirestore(doc);

      expect(manifest.overlay, const OverlaySettings());
    });

    test('surfaces structural problems as schema exceptions', () {
      final missingClips = versionedFixture()..remove('clips');
      final badClip = versionedFixture();
      ((badClip['clips']! as List<Object?>).first! as Map<String, Object?>)
          .remove('sha256');
      final badOverlay = versionedFixture()..['overlay'] = 'not-a-map';

      for (final doc in [missingClips, badClip, badOverlay]) {
        expect(
          () => manifestFromFirestore(doc),
          throwsA(isA<ManifestSchemaException>()),
          reason: 'doc: $doc',
        );
      }
    });
  });

  group('StaticManifestSource', () {
    test('emits the fixture once per subscription, then closes', () async {
      final fixture = manifestFromFirestore(versionedFixture());
      final ManifestSource source = StaticManifestSource(fixture);

      final emitted = await source
          .watchCurrent(partyId: 'party-1', channelId: 'cctv')
          .toList();

      expect(emitted, hasLength(1));
      expect(emitted.single, fixture);
    });

    test('emitted manifest is a valid CCTV wall manifest', () async {
      final fixture = manifestFromFirestore(versionedFixture());
      final source = StaticManifestSource(fixture);

      final emitted = await source
          .watchCurrent(partyId: 'party-1', channelId: 'cctv')
          .toList();

      final Result<PlaybackManifest> validated = validateCctvManifest(
        emitted.single,
      );
      expect(validated.isOk, isTrue);
      expect(
        emitted.single.clips.map((c) => c.cameraId).toSet(),
        kCctvCameraIds,
      );
      for (final clip in emitted.single.clips) {
        expect(clip.sha256, hasLength(64));
        expect(clip.sizeBytes, greaterThan(0));
        expect(clip.duration, greaterThan(Duration.zero));
      }
    });

    test('serves every subscriber independently', () async {
      final fixture = manifestFromFirestore(versionedFixture());
      final source = StaticManifestSource(fixture);

      final first = source
          .watchCurrent(partyId: 'party-1', channelId: 'cctv')
          .toList();
      final second = source
          .watchCurrent(partyId: 'party-2', channelId: 'cctv')
          .toList();

      expect(await first, [fixture]);
      expect(await second, [fixture]);
    });
  });
}
