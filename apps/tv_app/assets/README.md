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

If `ffmpeg` is not installed, the script still succeeds: it writes minimal
but structurally valid MP4 placeholders (ftyp + moov + mdat, no decodable
track) so `flutter build apk` works fully offline. Those placeholders make
`video_player` report an error, which the wall renders as `SIGNAL LOST` for
that tile — the other tiles keep playing.
