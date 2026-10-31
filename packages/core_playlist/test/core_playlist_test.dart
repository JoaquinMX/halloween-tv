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

    test('manifest version must advance beyond committed version', () {
      final current = manifest(version: 4);
      expect(validateManifestVersion(current, null).isOk, isTrue);
      expect(validateManifestVersion(manifest(version: 5), 4).isOk, isTrue);
      final stale = validateManifestVersion(manifest(version: 4), 4);
      expect(stale, isA<Err<PlaybackManifest>>());
      expect((stale as Err<PlaybackManifest>).message, contains('newer'));
      expect(validateManifestVersion(manifest(version: 3), 4).isErr, isTrue);
    });

    test('camera assignments cover every slot even when order differs', () {
      final reversed = manifest(
        clips: <ClipDescriptor>[clipAt(4), clipAt(3), clipAt(2), clipAt(1)],
      );
      expect(validateCctvManifest(reversed).isOk, isTrue);
      expect(
        reversed.clips.map((clip) => slotForCameraId(clip.cameraId)!.index),
        <int>[3, 2, 1, 0],
      );
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

    test('overlong clip ids are rejected', () {
      ClipDescriptor longId(String id) => ClipDescriptor(
        id: id,
        cameraId: 'CAM-01',
        storageObjectId: 'obj-01',
        sha256: sha('clip-01'),
        sizeBytes: 10,
        duration: const Duration(seconds: 5),
        mimeType: 'video/mp4',
      );
      final ok = manifest(
        clips: <ClipDescriptor>[
          longId('c' * kMaxClipIdLength),
          clipAt(2),
          clipAt(3),
          clipAt(4),
        ],
      );
      expect(validateCctvManifest(ok).isOk, isTrue);
      final bad = manifest(
        clips: <ClipDescriptor>[
          longId('c' * (kMaxClipIdLength + 1)),
          clipAt(2),
          clipAt(3),
          clipAt(4),
        ],
      );
      final r = validateCctvManifest(bad);
      expect(r.isErr, isTrue);
      expect((r as Err<PlaybackManifest>).message, contains('exceeds'));
    });
  });

  group('cctvSlots (single source of truth)', () {
    test('canonical order, ids, indices, and default rooms', () {
      expect(
        cctvSlots.map((s) => s.id).toList(),
        <String>['CAM-01', 'CAM-02', 'CAM-03', 'CAM-04'],
      );
      expect(cctvSlots.map((s) => s.index).toList(), <int>[0, 1, 2, 3]);
      expect(
        cctvSlots.map((s) => s.room).toList(),
        <String>['hallway', 'kitchen', 'staircase', 'storage room'],
      );
      expect(
        cctvSlots.map((s) => s.defaultLabel).toList(),
        <String>[
          'CAM-01 · hallway',
          'CAM-02 · kitchen',
          'CAM-03 · staircase',
          'CAM-04 · storage room',
        ],
      );
    });

    test('kCctvCameraIds matches the slot ids', () {
      expect(kCctvCameraIds, cctvSlots.map((s) => s.id).toSet());
    });

    test('slotForCameraId resolves known cameras and nulls unknown ones', () {
      expect(slotForCameraId('CAM-01')!.index, 0);
      expect(slotForCameraId('CAM-04')!.room, 'storage room');
      expect(slotForCameraId('CAM-05'), isNull);
      expect(slotForCameraId(''), isNull);
    });
  });

  group('cctv clip counts (configurable 1/2/4 layouts)', () {
    List<ClipDescriptor> firstN(int n) => <ClipDescriptor>[
      for (var i = 1; i <= n; i++) clipAt(i),
    ];

    test('supported counts, default, and expected prefixes', () {
      expect(kSupportedCctvClipCounts, <int>[1, 2, 4]);
      expect(kDefaultCctvClipCount, 4);
      expect(isSupportedCctvClipCount(1), isTrue);
      expect(isSupportedCctvClipCount(2), isTrue);
      expect(isSupportedCctvClipCount(4), isTrue);
      expect(isSupportedCctvClipCount(0), isFalse);
      expect(isSupportedCctvClipCount(3), isFalse);
      expect(isSupportedCctvClipCount(5), isFalse);
      expect(expectedCctvCameraIds(1), <String>['CAM-01']);
      expect(expectedCctvCameraIds(2), <String>['CAM-01', 'CAM-02']);
      expect(
        expectedCctvCameraIds(4),
        <String>['CAM-01', 'CAM-02', 'CAM-03', 'CAM-04'],
      );
      expect(() => expectedCctvCameraIds(3), throwsArgumentError);
    });

    test('1, 2, and 4-clip manifests validate through the real path', () {
      for (final n in <int>[1, 2, 4]) {
        final m = manifest(clips: firstN(n));
        final r = validateCctvManifest(m);
        expect(r.isOk, isTrue, reason: '$n-clip manifest should validate');
        // JSON round-trip preserves the count and still validates.
        final reparsed = parseManifest(m.toJson());
        expect(reparsed.clips, hasLength(n));
        expect(validateCctvManifest(reparsed).isOk, isTrue);
      }
    });

    test('reordered 1/2/4-clip manifests remain accepted', () {
      expect(
        validateCctvManifest(manifest(clips: firstN(2).reversed.toList())).isOk,
        isTrue,
      );
      expect(
        validateCctvManifest(
          manifest(
            clips: <ClipDescriptor>[clipAt(4), clipAt(2), clipAt(1), clipAt(3)],
          ),
        ).isOk,
        isTrue,
      );
    });

    test('unsupported counts, gaps, duplicates, and unknown cameras reject', () {
      for (final count in <int>[0, 3, 5, 6]) {
        final clips = <ClipDescriptor>[
          for (var i = 1; i <= count; i++)
            ClipDescriptor(
              id: 'clip-$i',
              cameraId: 'CAM-0$i',
              storageObjectId: 'obj-$i',
              sha256: sha('clip-$i'),
              sizeBytes: 10,
              duration: const Duration(seconds: 5),
              mimeType: 'video/mp4',
            ),
        ];
        final r = validateCctvManifest(manifest(clips: clips));
        expect(r.isErr, isTrue, reason: 'count $count should be rejected');
      }
      // Gap: {CAM-01, CAM-03} is not the first-2 prefix.
      final gap = manifest(
        clips: <ClipDescriptor>[clipAt(1), clipAt(3)],
      );
      final gapResult = validateCctvManifest(gap);
      expect(gapResult.isErr, isTrue);
      expect(
        (gapResult as Err<PlaybackManifest>).message,
        contains('first 2'),
      );
      // {CAM-02} alone is not the first-1 prefix.
      expect(validateCctvManifest(manifest(clips: <ClipDescriptor>[clipAt(2)])).isErr, isTrue);
      // Duplicate clip ids within a 2-clip manifest.
      final dupId = <ClipDescriptor>[clipAt(1), clipAt(1)];
      expect(validateCctvManifest(manifest(clips: dupId)).isErr, isTrue);
      // Unknown camera within an otherwise supported count.
      final unknown = <ClipDescriptor>[
        clipAt(1),
        ClipDescriptor(
          id: 'clip-x',
          cameraId: 'CAM-05',
          storageObjectId: 'obj-x',
          sha256: sha('clip-x'),
          sizeBytes: 10,
          duration: const Duration(seconds: 5),
          mimeType: 'video/mp4',
        ),
      ];
      final unknownResult = validateCctvManifest(manifest(clips: unknown));
      expect(unknownResult.isErr, isTrue);
      expect(
        (unknownResult as Err<PlaybackManifest>).message,
        contains('CAM-05'),
      );
      // Invalid existing metadata still rejected at supported counts.
      final badSha = <ClipDescriptor>[
        const ClipDescriptor(
          id: 'clip-01',
          cameraId: 'CAM-01',
          storageObjectId: 'obj-01',
          sha256: 'not-a-hash',
          sizeBytes: 10,
          duration: Duration(seconds: 5),
          mimeType: 'video/mp4',
        ),
      ];
      expect(validateCctvManifest(manifest(clips: badSha)).isErr, isTrue);
    });
  });

  group('clip labels (config-driven, owner Q3)', () {
    ClipDescriptor labeled(int i, String? label) => ClipDescriptor(
      id: 'clip-0$i',
      cameraId: 'CAM-0$i',
      storageObjectId: 'obj-0$i',
      sha256: sha('clip-0$i'),
      sizeBytes: 1000 + i,
      duration: const Duration(seconds: 10),
      mimeType: 'video/mp4',
      label: label,
    );

    test('label round-trips through json and equality', () {
      final clip = labeled(1, 'Front Door');
      final back = ClipDescriptor.fromJson(clip.toJson());
      expect(back, equals(clip));
      expect(back.hashCode, clip.hashCode);
      expect(back.label, 'Front Door');
      expect(clip.toJson()['label'], 'Front Door');
    });

    test('absent label stays null and keeps the old wire shape', () {
      final clip = labeled(2, null);
      expect(clip.label, isNull);
      expect(clip.toJson().containsKey('label'), isFalse);
      expect(ClipDescriptor.fromJson(clip.toJson()), equals(clip));
    });

    test('resolveCctvLabel prefers custom labels, else slot defaults', () {
      expect(resolveCctvLabel(labeled(1, 'Front Door')), 'Front Door');
      expect(resolveCctvLabel(labeled(2, null)), 'CAM-02 · kitchen');
      expect(resolveCctvLabel(labeled(3, '   ')), 'CAM-03 · staircase');
    });

    test('custom-label manifest drives wall slot labels end-to-end', () {
      // Manifest -> validate -> JSON round-trip -> per-clip label
      // resolution, all on prod code. The channel-level counterpart lives in
      // channel_cctv (tileForClip + wall widget test), so this covers the
      // domain half of the path with wall-slot ordering preserved.
      final m = manifest(
        clips: <ClipDescriptor>[
          labeled(1, 'Front Door'),
          labeled(2, null),
          labeled(3, 'Basement'),
          labeled(4, 'Attic'),
        ],
      );
      expect(validateCctvManifest(m).isOk, isTrue);
      final reparsed = parseManifest(m.toJson());
      expect(validateCctvManifest(reparsed).isOk, isTrue);
      final labels = <String>[
        for (var i = 0; i < 4; i++)
          resolveCctvLabel(reparsed.clips[i]),
      ];
      expect(labels, <String>[
        'Front Door',
        'CAM-02 · kitchen',
        'Basement',
        'Attic',
      ]);
      // Slot placement still follows camera identity, not clip order.
      expect(
        reparsed.clips.map((c) => slotForCameraId(c.cameraId)!.index).toList(),
        <int>[0, 1, 2, 3],
      );
    });
  });
}
