# Fixture clips

`cam01.mp4` … `cam04.mp4` are the four muted synthetic CCTV loops the wall
plays in Phase 1 (no network yet).

| file | recipe | size |
| --- | --- | --- |
| `cam01.mp4` | dark green hall + grain | 84275 B |
| `cam02.mp4` | warm dim kitchen + grain | 81309 B |
| `cam03.mp4` | darkened `testsrc2` (staircase motion) | 135240 B |
| `cam04.mp4` | heavy static burst (storage room) | 190783 B |

All clips are 960x540, 24 fps, H.264 Constrained Baseline, `yuv420p`, 2 s,
no audio track, `+faststart`. Total 491607 B — well under the 2 MiB
budget for committed binaries.

Regenerate (requires `ffmpeg`):

```sh
bash tool/gen_fixtures.sh
bash tool/gen_fixtures.sh --check   # CI gate: ffprobe decodability + manifest reconciliation (sha256/sizeBytes) + budget
```

If `ffmpeg` is not installed, the script REFUSES to touch existing
fixtures and exits 1 (it never overwrites good clips with undecodable
placeholders). Placeholder MP4s are only written with explicit
`--allow-placeholders` on an empty assets dir, exit 0 with a loud warning,
and `--check` fails on them by design (they carry no decodable track, so
boot fails closed to WALL UNAVAILABLE — `durationMs: 0` is rejected by
manifest validation before any tile ever builds).

`fixture_manifest.json` is emitted alongside the clips: per-clip
`{cameraId, sha256, sizeBytes, durationMs, asset}` generated from the real
bytes. The wall loads it at boot as the offline fallback manifest and
verifies clip hashes before playback. Regenerate clips and manifest
together — never edit one without the other.
