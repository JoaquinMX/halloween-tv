#!/usr/bin/env bash
# Generate the four synthetic CCTV fixture clips (assets/cam01..cam04.mp4).
#
# Contract:
#   * 960x540, 24 fps, muted (no audio stream), H.264 yuv420p baseline, 2 s,
#     loopable (first/last frame match closely), faststart for streaming.
#   * Total on-disk budget < 2 MiB so the clips can be committed.
#
# ffmpeg present  -> real synthetic clips (color/noise/motion per camera).
# ffmpeg missing  -> the script still succeeds: it writes minimal MP4
#                    placeholders so `flutter build apk` works offline, and
#                    prints a warning. Placeholder clips decode as broken in
#                    video_player, which the wall handles by showing
#                    SIGNAL LOST for that tile (single-tile failure).
#
# Usage: sh tool/gen_fixtures.sh [--check]
#   --check  verify the committed clips exist and stay under budget (CI gate);
#            never writes anything.
set -euo pipefail

ASSETS_DIR="$(cd "$(dirname "$0")/.." && pwd)/assets"
CAMERAS=(cam01 cam02 cam03 cam04)
BUDGET_KIB=2048
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

if [[ "$CHECK_ONLY" == "1" ]]; then
  total=0
  for cam in "${CAMERAS[@]}"; do
    f="$ASSETS_DIR/$cam.mp4"
    if [[ ! -s "$f" ]]; then
      echo "MISSING: $f (run: sh tool/gen_fixtures.sh)" >&2
      exit 1
    fi
    total=$(( total + $(du -k "$f" | cut -f1) ))
  done
  echo "fixtures OK: ${total} KiB (budget ${BUDGET_KIB} KiB)"
  [[ "$total" -le "$BUDGET_KIB" ]] || { echo "OVER BUDGET" >&2; exit 1; }
  exit 0
fi

mkdir -p "$ASSETS_DIR"

# One synthetic recipe per camera: dark base + grain, plus motion where the
# room is meant to feel "alive" (staircase pan, storage static burst).
recipes=(
  "color=c=0x08120c:s=960x540:r=24,format=yuv420p,noise=alls=26:allf=t+u"
  "color=c=0x140d08:s=960x540:r=24,format=yuv420p,noise=alls=22:allf=t+u"
  "testsrc2=s=960x540:r=24,eq=brightness=-0.62:saturation=0.18:contrast=1.4,noise=alls=18:allf=t"
  "color=c=0x050507:s=960x540:r=24,format=yuv420p,noise=alls=40:allf=t+u"
)
crfs=(36 36 40 38)

if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg found: generating synthetic fixtures into $ASSETS_DIR"
  pids=()
  for i in "${!CAMERAS[@]}"; do
    out="$ASSETS_DIR/${CAMERAS[$i]}.mp4"
    ffmpeg -hide_banner -loglevel error -y \
      -f lavfi -i "${recipes[$i]}" \
      -t 2 -r 24 -s 960x540 \
      -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.1 \
      -crf "${crfs[$i]}" -preset veryfast -g 48 -an \
      -movflags +faststart \
      "$out" &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do wait "$pid"; done
else
  echo "WARNING: ffmpeg not found - writing minimal MP4 placeholders." >&2
  echo "         Install ffmpeg and re-run for real synthetic clips." >&2
  python3 - "$ASSETS_DIR" "${CAMERAS[@]}" <<'PY'
import os
import struct
import sys

out_dir, cameras = sys.argv[1], sys.argv[2:]


def box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack('>I', 8 + len(payload)) + kind + payload


# ftyp + moov(mvhd) + empty mdat: a structurally valid MP4 container with no
# decodable track. Enough for the asset pipeline; playback yields an error
# that the wall renders as SIGNAL LOST for the affected tile.
ftyp = box(b'ftyp', b'isom' + struct.pack('>I', 0x200) + b'isomiso2avc1mp41')
mvhd = struct.pack(
    '>IIIIIIIIIIII',
    0, 0, 0, 1000, 2000, 0x00010000, 0x01000000, 0, 0, 0, 2, 0,
)
moov = box(b'moov', box(b'mvhd', mvhd))
mdat = box(b'mdat', b'')
for cam in cameras:
    path = os.path.join(out_dir, cam + '.mp4')
    with open(path, 'wb') as handle:
        handle.write(ftyp + moov + mdat)
    print('placeholder', os.path.basename(path))
PY
fi

echo "sizes:"
ls -l "$ASSETS_DIR"/cam0*.mp4
total=$(du -ck "$ASSETS_DIR"/cam0*.mp4 | tail -1 | cut -f1)
echo "total: ${total} KiB (budget ${BUDGET_KIB} KiB)"
if [[ "$total" -gt "$BUDGET_KIB" ]]; then
  echo "ERROR: fixtures exceed the ${BUDGET_KIB} KiB budget" >&2
  exit 1
fi
