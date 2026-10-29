# Fixture clips

`cam01.mp4` … `cam04.mp4` are the four muted synthetic CCTV loops the wall
plays in Phase 1 (no network yet).

| file | recipe | size |
| --- | --- | --- |
| `cam01.mp4` | dark green hall + grain | ~85 KiB |
| `cam02.mp4` | warm dim kitchen + grain | ~80 KiB |
| `cam03.mp4` | darkened `testsrc2` (staircase motion) | ~120 KiB |
| `cam04.mp4` | heavy static burst (storage room) | ~270 KiB |

All clips are 960x540, 24 fps, H.264 Constrained Baseline, `yuv420p`, 2 s,
no audio track, `+faststart`. Total ≈ 560 KiB — well under the 2 MiB
budget for committed binaries.

Regenerate (requires `ffmpeg`):

```sh
sh tool/gen_fixtures.sh
sh tool/gen_fixtures.sh --check   # CI gate: files exist and stay in budget
```

If `ffmpeg` is not installed, the script REFUSES to touch existing
fixtures and exits 1 (it never overwrites good clips with undecodable
placeholders). Placeholder MP4s are only written with explicit
`--allow-placeholders` on an empty assets dir, exit 0 with a loud warning,
and `--check` fails on them by design (they carry no decodable track, so
every tile would render `SIGNAL LOST`).

`fixture_manifest.json` is emitted alongside the clips: per-clip
`{cameraId, sha256, sizeBytes, durationMs, asset}` generated from the real
bytes. The wall loads it at boot as the offline fallback manifest and
verifies clip hashes before playback. Regenerate clips and manifest
together — never edit one without the other.
