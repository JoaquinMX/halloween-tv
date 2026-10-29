import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';

String sha(String seed) {
  final units = seed.codeUnits;
  final buf = StringBuffer();
  var h = 0x811c9dc5;
  while (buf.length < 64) {
    for (final u in units) {
      h = ((h ^ u) * 16777619) & 0xffffffff;
      buf.write(h.toRadixString(16).padLeft(8, '0'));
      if (buf.length >= 64) {
        break;
      }
    }
  }
  return buf.toString().substring(0, 64);
}

ClipDescriptor clipAt(int i) => ClipDescriptor(
  id: 'clip-0$i',
  cameraId: 'CAM-0$i',
  storageObjectId: 'obj-0$i',
  sha256: sha('clip-0$i'),
  sizeBytes: 1000 + i,
  duration: const Duration(seconds: 10),
  mimeType: 'video/mp4',
);

PlaybackManifest manifest({
  String partyId = 'party-1',
  String channelId = 'cctv',
  int version = 3,
  List<ClipDescriptor>? clips,
  OverlaySettings overlay = const OverlaySettings(),
}) => PlaybackManifest(
  partyId: partyId,
  channelId: channelId,
  version: version,
  overlay: overlay,
  publishedAt: DateTime.utc(2026, 10, 31, 20),
  clips: clips ?? <ClipDescriptor>[for (var i = 1; i <= 4; i++) clipAt(i)],
);

PlaybackManifest validManifest() => manifest();

void main() {
  group('validation', () {
    test('valid manifest passes', () {
      final r = validateCctvManifest(validManifest());
      expect(r, isA<Ok<PlaybackManifest>>());
      expect((r as Ok<PlaybackManifest>).value.clips, hasLength(4));
    });

    test('blank party/channel rejected', () {
      expect(
        (validateCctvManifest(manifest(partyId: '  ')) as Err<PlaybackManifest>)
            .message,
        contains('partyId'),
      );
      expect(
        (validateCctvManifest(manifest(channelId: '')) as Err<PlaybackManifest>)
            .message,
        contains('channelId'),
      );
    });

    test('version <= 0 rejected', () {
      for (final bad in <int>[0, -1]) {
        final r = validateCctvManifest(manifest(version: bad));
        expect(r, isA<Err<PlaybackManifest>>());
        expect((r as Err<PlaybackManifest>).message, contains('version'));
      }
    });

    test('clip count other than 4 rejected', () {
      for (final count in <int>[0, 3, 5]) {
        final clips = <ClipDescriptor>[
          for (var i = 1; i <= count; i++) clipAt(i),
        ];
        final r = validateCctvManifest(manifest(clips: clips));
        expect(r.isErr, isTrue);
        expect((r as Err<PlaybackManifest>).message, contains('4 clips'));
      }
    });

    test('duplicate camera rejected', () {
      final clips = <ClipDescriptor>[for (var i = 1; i <= 4; i++) clipAt(i)];
      clips[3] = ClipDescriptor(
        id: 'clip-99',
        cameraId: 'CAM-01',
        storageObjectId: 'obj-99',
        sha256: sha('clip-99'),
        sizeBytes: 10,
        duration: const Duration(seconds: 5),
        mimeType: 'video/mp4',
      );
      final r = validateCctvManifest(manifest(clips: clips));
      expect(r.isErr, isTrue);
      expect(
        (r as Err<PlaybackManifest>).message,
        contains('duplicate cameraId'),
      );
    });

    test('unknown camera id rejected', () {
      final clips = <ClipDescriptor>[for (var i = 1; i <= 4; i++) clipAt(i)];
      clips[0] = ClipDescriptor(
        id: 'clip-01',
        cameraId: 'CAM-05',
        storageObjectId: 'obj-01',
        sha256: sha('clip-01'),
        sizeBytes: 10,
        duration: const Duration(seconds: 5),
        mimeType: 'video/mp4',
      );
      final r = validateCctvManifest(manifest(clips: clips));
      expect(r.isErr, isTrue);
      expect((r as Err<PlaybackManifest>).message, contains('CAM-05'));
    });

    test('duplicate clip id rejected', () {
      final clips = <ClipDescriptor>[for (var i = 1; i <= 4; i++) clipAt(i)];
      clips[3] = ClipDescriptor(
        id: 'clip-01',
        cameraId: 'CAM-04',
        storageObjectId: 'obj-04',
        sha256: sha('clip-04'),
        sizeBytes: 10,
        duration: const Duration(seconds: 5),
        mimeType: 'video/mp4',
      );
      final r = validateCctvManifest(manifest(clips: clips));
      expect(r.isErr, isTrue);
      expect(
        (r as Err<PlaybackManifest>).message,
        contains('duplicate clip id'),
      );
    });

    test('malformed sha256 rejected', () {
      for (final badSha in <String>['', 'not-a-hash', 'a' * 63, 'z' * 64]) {
        final clips = <ClipDescriptor>[for (var i = 1; i <= 4; i++) clipAt(i)];
        clips[2] = ClipDescriptor(
          id: 'clip-03',
          cameraId: 'CAM-03',
          storageObjectId: 'obj-03',
          sha256: badSha,
          sizeBytes: 10,
          duration: const Duration(seconds: 5),
          mimeType: 'video/mp4',
        );
        final r = validateCctvManifest(manifest(clips: clips));
        expect(r.isErr, isTrue, reason: 'sha="$badSha" should be rejected');
        expect((r as Err<PlaybackManifest>).message, contains('sha256'));
      }
    });

    test('insane size and duration rejected', () {
      final zeroSize = ClipDescriptor(
        id: 'clip-01',
        cameraId: 'CAM-01',
        storageObjectId: 'obj-01',
        sha256: sha('clip-01'),
        sizeBytes: 0,
        duration: const Duration(seconds: 5),
        mimeType: 'video/mp4',
      );
      final clips = <ClipDescriptor>[zeroSize, clipAt(2), clipAt(3), clipAt(4)];
      final r = validateCctvManifest(manifest(clips: clips));
      expect((r as Err<PlaybackManifest>).message, contains('sizeBytes'));

      final zeroDuration = ClipDescriptor(
        id: 'clip-01',
        cameraId: 'CAM-01',
        storageObjectId: 'obj-01',
        sha256: sha('clip-01'),
        sizeBytes: 10,
        duration: Duration.zero,
        mimeType: 'video/mp4',
      );
      final clips2 = <ClipDescriptor>[
        zeroDuration,
        clipAt(2),
        clipAt(3),
        clipAt(4),
      ];
      final r2 = validateCctvManifest(manifest(clips: clips2));
      expect((r2 as Err<PlaybackManifest>).message, contains('duration'));
    });
  });

  group('json', () {
    test('round-trip preserves sha256 and every field', () {
      final m = validManifest();
      final parsed = parseManifest(m.toJson());
      expect(
        parsed.clips.map((c) => c.sha256).toList(),
        m.clips.map((c) => c.sha256).toList(),
      );
      expect(parsed, equals(m));
      expect(parsed.hashCode, m.hashCode);
      expect(validateCctvManifest(parsed).isOk, isTrue);
    });

    test('round-trip preserves overlay values', () {
      const overlay = OverlaySettings(
        scanlineOpacity: 0.1,
        noiseLevel: 0.9,
        vignette: 0.2,
      );
      final parsed = parseManifest(manifest(overlay: overlay).toJson());
      expect(parsed.overlay, equals(overlay));
    });

    test('publishedAt is serialised as UTC ISO-8601', () {
      final m = manifest();
      expect(m.toJson()['publishedAt'], '2026-10-31T20:00:00.000Z');
      expect(parseManifest(m.toJson()).publishedAt.isUtc, isTrue);
    });

    test('out-of-range overlay numerics are clamped on parse', () {
      final json = validManifest().toJson();
      json['overlay'] = <String, Object?>{
        'scanlineOpacity': 4.5,
        'noiseLevel': -2,
        'vignette': 0.25,
      };
      final parsed = parseManifest(json);
      expect(parsed.overlay.scanlineOpacity, 1.0);
      expect(parsed.overlay.noiseLevel, 0.0);
      expect(parsed.overlay.vignette, 0.25);
      // And the clamped manifest still validates.
      expect(validateCctvManifest(parsed).isOk, isTrue);
    });

    test('missing overlay falls back to defaults', () {
      final json = validManifest().toJson()..remove('overlay');
      expect(parseManifest(json).overlay, const OverlaySettings());
    });

    test('parseManifest throws FormatException on bad shape', () {
      expect(
        () => parseManifest(<String, Object?>{'nope': 1}),
        throwsFormatException,
      );
      expect(
        () => parseManifest(<String, Object?>{
          'partyId': 'p',
          'channelId': 'c',
          'version': 1,
          'clips': 'not-a-list',
          'publishedAt': '2026-10-31T20:00:00Z',
        }),
        throwsFormatException,
      );
      expect(
        () => parseManifest(<String, Object?>{
          'partyId': 'p',
          'channelId': 'c',
          'version': 1,
          'clips': <Object?>[],
          'overlay': 'nope',
          'publishedAt': '2026-10-31T20:00:00Z',
        }),
        throwsFormatException,
      );
      expect(
        () => parseManifest(<String, Object?>{
          'partyId': 'p',
          'channelId': 'c',
          'version': 1,
          'clips': <Object?>[],
          'publishedAt': 'not-a-date',
        }),
        throwsFormatException,
      );
    });

    test('clip json includes duration in milliseconds', () {
      final json = clipAt(1).toJson();
      expect(json['durationMs'], 10000);
      expect(ClipDescriptor.fromJson(json), equals(clipAt(1)));
    });

    test('manifest clips are unmodifiable', () {
      final m = validManifest();
      expect(() => m.clips.add(clipAt(1)), throwsUnsupportedError);
    });

    test('isValidSha256Hex accepts hex and rejects junk', () {
      expect(isValidSha256Hex(sha('x')), isTrue);
      expect(isValidSha256Hex('A' * 64), isTrue);
      expect(isValidSha256Hex('a' * 63), isFalse);
      expect(isValidSha256Hex(''), isFalse);
      expect(isValidSha256Hex('g' * 64), isFalse);
    });
  });
}
