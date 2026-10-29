#!/usr/bin/env bash
# Generate the four synthetic CCTV fixture clips (assets/cam01..cam04.mp4)
# plus assets/fixture_manifest.json.
#
# Contract (see assets/README.md, p2 consumes fixture_manifest.json):
#   * 960x540, 24 fps, yuv420p H.264 Constrained Baseline, ~2 s, no audio
#     stream, +faststart for streaming.
#   * Total on-disk budget <= 2 MiB (2097152 bytes) so the clips can be
#     committed.
#   * fixture_manifest.json: {"clips":[{cameraId,sha256,sizeBytes,durationMs,
#     asset}]} with cameraId CAM-01..CAM-04, sha256 = lowercase hex sha256 of
#     the committed file bytes, sizeBytes = file size, durationMs = integer
#     milliseconds, asset = path relative to the app root (e.g.
#     "assets/cam01.mp4", matching kCameraAssetPaths).
#
# Determinism: fixed per-camera noise seeds, a single encode thread, and
# bitexact muxer/encoder flags make re-runs byte-identical, so the sha256
# values in the manifest stay stable across regenerations.
#
# Modes:
#   (default)   ffmpeg present  -> encode the four clips, write the manifest,
#                                  then self-check the result via --check.
#               ffmpeg missing  -> REFUSE. Exit non-zero, nothing written.
#                                  Placeholders are only written with an
#                                  explicit --allow-placeholders on an assets
#                                  dir that holds no fixture clips and no
#                                  manifest. Placeholders are NOT decodable,
#                                  so --check fails on them by design (the
#                                  wall shows SIGNAL LOST for those tiles).
#   --check     Never writes. Verifies existence + decodability via ffprobe
#               (stream v:0, codec_name=h264, 960x540, yuv420p, 24 fps,
#               nb_frames>0, no audio) and reconciles sha256, sizeBytes,
#               durationMs and asset against fixture_manifest.json, plus the
#               2 MiB budget. Exits non-zero with a clear message on any
#               failure (including a missing ffprobe).
#
# Usage: bash tool/gen_fixtures.sh [--check] [--allow-placeholders]
#   --check               verify committed fixtures (CI gate); read-only.
#   --allow-placeholders  no-ffmpeg only: allow writing undecodable
#                         placeholder MP4s (+ manifest with durationMs 0)
#                         when no fixtures exist yet. Ignored when ffmpeg is
#                         present.
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS_DIR="$APP_ROOT/assets"
MANIFEST="$ASSETS_DIR/fixture_manifest.json"
CAMERAS=(cam01 cam02 cam03 cam04)
CAM_IDS=(CAM-01 CAM-02 CAM-03 CAM-04)
BUDGET_BYTES=2097152
EXPECT_W=960
EXPECT_H=540
EXPECT_CODEC="h264"
EXPECT_PIX_FMT="yuv420p"
EXPECT_FPS="24/1"
DURATION_MS_MIN=1500
DURATION_MS_MAX=3000

usage() {
  sed -n '2,/^set -euo pipefail$/p' "$0" | grep -v '^set -euo pipefail$' | sed 's/^# \?//'
}

CHECK_ONLY=0
ALLOW_PLACEHOLDERS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --allow-placeholders) ALLOW_PLACEHOLDERS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2
       echo "Usage: bash tool/gen_fixtures.sh [--check] [--allow-placeholders]" >&2
       exit 2 ;;
  esac
  shift
done

have() { command -v "$1" >/dev/null 2>&1; }

require_python() {
  if ! have python3; then
    echo "ERROR: python3 not found (needed to write/verify fixture_manifest.json)" >&2
    exit 1
  fi
}

# One synthetic recipe per camera: dark base + grain, plus motion where the
# room is meant to feel "alive" (staircase pan, storage static burst).
# all_seed pins the grain so re-runs are byte-identical.
recipes=(
  "color=c=0x08120c:s=960x540:r=24,format=yuv420p,noise=alls=26:allf=t+u:all_seed=11"
  "color=c=0x140d08:s=960x540:r=24,format=yuv420p,noise=alls=22:allf=t+u:all_seed=22"
  "testsrc2=s=960x540:r=24,eq=brightness=-0.62:saturation=0.18:contrast=1.4,noise=alls=18:allf=t:all_seed=33"
  "color=c=0x050507:s=960x540:r=24,format=yuv420p,noise=alls=40:allf=t+u:all_seed=44"
)
crfs=(36 36 40 38)

# Emit fixture_manifest.json from the files on disk.
#   real         -> durationMs is the ffprobe-measured duration (fatal if it
#                   cannot be measured).
#   placeholder  -> durationMs is 0 (no decodable track to measure).
write_manifest() {
  local mode="$1"
  export CAMERAS_CSV CAM_IDS_CSV
  CAMERAS_CSV="$(IFS=,; echo "${CAMERAS[*]}")"
  CAM_IDS_CSV="$(IFS=,; echo "${CAM_IDS[*]}")"
  python3 - "$ASSETS_DIR" "$MANIFEST" "$mode" <<'PY'
import hashlib
import json
import os
import shutil
import subprocess
import sys

assets, manifest_path, mode = sys.argv[1], sys.argv[2], sys.argv[3]
cams = os.environ["CAMERAS_CSV"].split(",")
ids = os.environ["CAM_IDS_CSV"].split(",")


def measure_ms(path):
    """Return probed duration in integer ms, or None if it cannot be measured."""
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        return None
    proc = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True)
    if proc.returncode != 0:
        return None
    try:
        return int(round(float(proc.stdout.strip()) * 1000))
    except ValueError:
        return None


clips = []
for cam, cid in zip(cams, ids):
    path = os.path.join(assets, cam + ".mp4")
    with open(path, "rb") as handle:
        data = handle.read()
    if mode == "placeholder":
        duration_ms = 0
    else:
        measured = measure_ms(path)
        if measured is None or measured <= 0:
            print("ERROR: cannot measure duration of %s with ffprobe; "
                  "refusing to write a manifest with a fake durationMs" % path,
                  file=sys.stderr)
            sys.exit(1)
        duration_ms = measured
    clips.append({
        "cameraId": cid,
        "sha256": hashlib.sha256(data).hexdigest(),
        "sizeBytes": len(data),
        "durationMs": duration_ms,
        "asset": "assets/%s.mp4" % cam,
    })

tmp = manifest_path + ".tmp"
with open(tmp, "w") as handle:
    json.dump({"clips": clips}, handle, indent=2)
    handle.write("\n")
os.replace(tmp, manifest_path)
print("wrote %s (%d clips, mode=%s)" % (manifest_path, len(clips), mode))
PY
}

print_sizes_and_budget() {
  echo "sizes:"
  ls -l "$ASSETS_DIR"/cam0*.mp4
  local total
  total=$(python3 - "$ASSETS_DIR" <<'PY'
import glob
import os
import sys
print(sum(os.path.getsize(p) for p in sorted(glob.glob(os.path.join(sys.argv[1], "cam0*.mp4")))))
PY
)
  echo "total: ${total} bytes (budget ${BUDGET_BYTES} bytes)"
  if [ "$total" -gt "$BUDGET_BYTES" ]; then
    echo "ERROR: fixtures total ${total} bytes exceed the ${BUDGET_BYTES} byte budget" >&2
    exit 1
  fi
}

# Read-only gate: existence + decodability (ffprobe) + manifest reconciliation.
run_check() {
  require_python
  if ! have ffprobe; then
    echo "CHECK FAILED: ffprobe not found (ffprobe is required to prove the" >&2
    echo "  fixture clips are decodable; install ffmpeg and re-run)" >&2
    exit 1
  fi
  if [ ! -s "$MANIFEST" ]; then
    echo "CHECK FAILED: missing or empty manifest: $MANIFEST" >&2
    echo "  Run: bash tool/gen_fixtures.sh" >&2
    exit 1
  fi
  for cam in "${CAMERAS[@]}"; do
    if [ ! -s "$ASSETS_DIR/$cam.mp4" ]; then
      echo "CHECK FAILED: MISSING or empty: $ASSETS_DIR/$cam.mp4" >&2
      echo "  Run: bash tool/gen_fixtures.sh" >&2
      exit 1
    fi
  done
  export ASSETS_DIR MANIFEST EXPECT_W EXPECT_H EXPECT_CODEC EXPECT_PIX_FMT EXPECT_FPS
  export CAMERAS_CSV CAM_IDS_CSV
  CAMERAS_CSV="$(IFS=,; echo "${CAMERAS[*]}")"
  CAM_IDS_CSV="$(IFS=,; echo "${CAM_IDS[*]}")"
  export DURATION_MS_MIN DURATION_MS_MAX BUDGET_BYTES
  python3 - <<'PY'
import hashlib
import json
import os
import subprocess
import sys
from fractions import Fraction

assets = os.environ["ASSETS_DIR"]
manifest_path = os.environ["MANIFEST"]
exp_w = int(os.environ["EXPECT_W"])
exp_h = int(os.environ["EXPECT_H"])
exp_codec = os.environ["EXPECT_CODEC"]
exp_pix_fmt = os.environ["EXPECT_PIX_FMT"]
exp_fps = Fraction(os.environ["EXPECT_FPS"])
ms_min = int(os.environ["DURATION_MS_MIN"])
ms_max = int(os.environ["DURATION_MS_MAX"])
budget = int(os.environ["BUDGET_BYTES"])
cams = os.environ["CAMERAS_CSV"].split(",")
ids = os.environ["CAM_IDS_CSV"].split(",")

failures = []


def fail(msg):
    print("CHECK FAILED: %s" % msg, file=sys.stderr)
    failures.append(msg)


def probe(path, args):
    proc = subprocess.run(["ffprobe", "-v", "error"] + args + ["-of", "json", path],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        return None, (proc.stderr.strip() or "ffprobe exited %d" % proc.returncode)
    try:
        return json.loads(proc.stdout or "{}"), None
    except ValueError as exc:
        return None, "unparseable ffprobe output: %s" % exc


def count_frames(path):
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of", "json", path],
        capture_output=True, text=True)
    try:
        return int(json.loads(proc.stdout)["streams"][0]["nb_read_frames"])
    except (ValueError, KeyError, IndexError, TypeError):
        return -1


# ---- manifest shape -------------------------------------------------------
try:
    with open(manifest_path) as handle:
        manifest = json.load(handle)
except ValueError as exc:
    print("CHECK FAILED: %s is not valid JSON: %s" % (manifest_path, exc),
          file=sys.stderr)
    sys.exit(1)
if not isinstance(manifest, dict) or not isinstance(manifest.get("clips"), list):
    print('CHECK FAILED: %s must have shape {"clips": [...]}' % manifest_path,
          file=sys.stderr)
    sys.exit(1)

by_id = {}
for index, entry in enumerate(manifest["clips"]):
    if not isinstance(entry, dict):
        fail("manifest clips[%d] is not an object" % index)
        continue
    cid = entry.get("cameraId")
    if cid not in ids:
        fail("manifest clips[%d] has unknown cameraId %r (expected one of %s)"
             % (index, cid, ", ".join(ids)))
        continue
    if cid in by_id:
        fail("manifest has duplicate entry for cameraId %s" % cid)
        continue
    by_id[cid] = entry
for cid in ids:
    if cid not in by_id:
        fail("manifest has no entry for cameraId %s" % cid)
if len(manifest["clips"]) != len(ids):
    fail("manifest has %d clip entries (expected exactly %d)"
         % (len(manifest["clips"]), len(ids)))

# ---- per-clip existence, decodability, reconciliation ---------------------
total = 0
for cam, cid in zip(cams, ids):
    path = os.path.join(assets, cam + ".mp4")
    label = os.path.basename(path)
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        fail("%s: missing or empty file" % label)
        continue
    with open(path, "rb") as handle:
        data = handle.read()
    size = len(data)
    total += size
    digest = hashlib.sha256(data).hexdigest()

    info, err = probe(path, ["-select_streams", "v:0",
                             "-show_entries",
                             "stream=codec_name,width,height,pix_fmt,"
                             "r_frame_rate,avg_frame_rate,nb_frames,duration",
                             "-show_entries", "format=duration,size"])
    if info is None:
        fail("%s: not decodable by ffprobe (%s); undecodable placeholder? "
             "regenerate with: bash tool/gen_fixtures.sh" % (label, err))
        continue
    streams = info.get("streams") or []
    if len(streams) != 1:
        fail("%s: expected exactly 1 video stream, ffprobe found %d "
             "(placeholder clips carry no decodable track)" % (label, len(streams)))
        continue
    stream = streams[0]

    problems = []
    if stream.get("codec_name") != exp_codec:
        problems.append("codec_name=%r (expected %r)" % (stream.get("codec_name"), exp_codec))
    if stream.get("width") != exp_w or stream.get("height") != exp_h:
        problems.append("dimensions=%sx%s (expected %dx%d)"
                        % (stream.get("width"), stream.get("height"), exp_w, exp_h))
    if stream.get("pix_fmt") != exp_pix_fmt:
        problems.append("pix_fmt=%r (expected %r)" % (stream.get("pix_fmt"), exp_pix_fmt))
    fps_raw = stream.get("r_frame_rate") or stream.get("avg_frame_rate") or "0/1"
    try:
        fps = Fraction(fps_raw)
    except (ValueError, ZeroDivisionError):
        fps = Fraction(0, 1)
    if fps != exp_fps:
        problems.append("frame rate=%s (expected %s)" % (fps_raw, exp_fps))
    try:
        frames = int(stream.get("nb_frames"))
    except (TypeError, ValueError):
        frames = -1
    if frames <= 0:
        frames = count_frames(path)
    if frames <= 0:
        problems.append("nb_frames=%r (expected > 0 decodable frames)"
                        % (stream.get("nb_frames"),))
    audio, aerr = probe(path, ["-select_streams", "a", "-show_entries", "stream=index"])
    if audio is None:
        problems.append("could not verify audio streams (%s)" % aerr)
    elif audio.get("streams"):
        problems.append("unexpected audio stream (fixtures must be muted)")
    if problems:
        fail("%s: %s" % (label, "; ".join(problems)))
        continue

    entry = by_id.get(cid)
    if entry is None:
        continue  # already reported as a missing manifest entry
    want_asset = "assets/%s.mp4" % cam
    mismatches = []
    if entry.get("asset") != want_asset:
        mismatches.append("asset=%r (expected %r)" % (entry.get("asset"), want_asset))
    if entry.get("sha256") != digest:
        mismatches.append("sha256 (file=%s, manifest=%r) - re-run "
                          "bash tool/gen_fixtures.sh and commit the manifest"
                          % (digest, entry.get("sha256")))
    if entry.get("sizeBytes") != size:
        mismatches.append("sizeBytes (file=%d, manifest=%r)"
                          % (size, entry.get("sizeBytes")))
    duration = None
    fmt = info.get("format") or {}
    for candidate in (stream.get("duration"), fmt.get("duration")):
        try:
            duration = float(candidate)
            break
        except (TypeError, ValueError):
            continue
    manifest_ms = entry.get("durationMs")
    if not isinstance(manifest_ms, int) or isinstance(manifest_ms, bool) or manifest_ms <= 0:
        mismatches.append("durationMs=%r (expected a positive integer; 0 means a "
                          "placeholder manifest)" % (manifest_ms,))
    else:
        if not (ms_min <= manifest_ms <= ms_max):
            mismatches.append("durationMs=%d outside expected ~2s window %d..%d"
                              % (manifest_ms, ms_min, ms_max))
        if duration is not None and abs(manifest_ms - round(duration * 1000)) > 500:
            mismatches.append("durationMs=%d disagrees with ffprobe %dms"
                              % (manifest_ms, round(duration * 1000)))
    if mismatches:
        fail("%s: manifest mismatch: %s" % (label, "; ".join(mismatches)))

if total > budget:
    fail("fixtures total %d bytes exceed the %d byte budget" % (total, budget))

if failures:
    print("CHECK FAILED: %d problem(s) across fixtures in %s"
          % (len(failures), assets), file=sys.stderr)
    sys.exit(1)
print("fixtures OK: 4 clips, %d bytes (budget %d); decodable (ffprobe: h264 "
      "%dx%d %s %s fps, no audio) and sha256/size/duration reconciled "
      "against %s" % (total, budget, exp_w, exp_h, exp_pix_fmt, exp_fps,
                      manifest_path))
PY
}

if [ "$CHECK_ONLY" = "1" ]; then
  if [ "$ALLOW_PLACEHOLDERS" = "1" ]; then
    echo "NOTE: --allow-placeholders is meaningless with --check (read-only)" >&2
  fi
  run_check
  exit 0
fi

require_python
mkdir -p "$ASSETS_DIR"

if have ffmpeg; then
  if ! have ffprobe; then
    echo "ERROR: ffmpeg found but ffprobe is missing (they ship together;" >&2
    echo "       ffprobe is required to measure durations and self-check clips)" >&2
    exit 1
  fi
  if [ "$ALLOW_PLACEHOLDERS" = "1" ]; then
    echo "NOTE: --allow-placeholders ignored (ffmpeg present; generating real clips)"
  fi
  echo "ffmpeg found: generating synthetic fixtures into $ASSETS_DIR"
  # Sequential single-threaded encodes: deterministic, so re-runs are stable.
  for i in "${!CAMERAS[@]}"; do
    out="$ASSETS_DIR/${CAMERAS[$i]}.mp4"
    ffmpeg -hide_banner -loglevel error -y \
      -f lavfi -i "${recipes[$i]}" \
      -t 2 -r 24 -s 960x540 \
      -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.1 \
      -crf "${crfs[$i]}" -preset veryfast -g 48 -an \
      -threads 1 -fflags +bitexact -flags:v +bitexact \
      -movflags +faststart \
      "$out"
  done
  write_manifest real
  print_sizes_and_budget
  echo "self-check:"
  run_check
  exit 0
fi

# ---- ffmpeg missing -------------------------------------------------------
have_fixtures=0
for cam in "${CAMERAS[@]}"; do
  if [ -e "$ASSETS_DIR/$cam.mp4" ]; then have_fixtures=1; break; fi
done
if [ -e "$MANIFEST" ]; then have_fixtures=1; fi

if [ "$have_fixtures" = "1" ]; then
  echo "ERROR: ffmpeg not found, but fixtures already exist in $ASSETS_DIR." >&2
  echo "Refusing to overwrite them with undecodable placeholders (nothing written)." >&2
  echo "Install ffmpeg and re-run: bash tool/gen_fixtures.sh" >&2
  exit 1
fi
if [ "$ALLOW_PLACEHOLDERS" != "1" ]; then
  echo "ERROR: ffmpeg not found and no fixtures exist in $ASSETS_DIR. Nothing written." >&2
  echo "Either install ffmpeg and run: bash tool/gen_fixtures.sh" >&2
  echo "or explicitly opt into offline placeholders: bash tool/gen_fixtures.sh --allow-placeholders" >&2
  echo "NOTE: placeholders are not decodable; 'bash tool/gen_fixtures.sh --check'" >&2
  echo "will fail on them by design until real clips are generated." >&2
  exit 1
fi

echo "WARNING: ffmpeg not found - writing UNDECODABLE placeholder MP4s." >&2
echo "         'bash tool/gen_fixtures.sh --check' will fail on these by design." >&2
echo "         Install ffmpeg and re-run for real synthetic clips." >&2
python3 - "$ASSETS_DIR" "${CAMERAS[@]}" <<'PY'
import os
import struct
import sys

out_dir, cameras = sys.argv[1], sys.argv[2:]


def box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind + payload


# ftyp + moov(mvhd) + empty mdat: a structurally valid MP4 container with no
# decodable track. Enough for the asset pipeline; playback yields an error
# that the wall renders as SIGNAL LOST for the affected tile.
ftyp = box(b"ftyp", b"isom" + struct.pack(">I", 0x200) + b"isomiso2avc1mp41")
mvhd = struct.pack(
    ">IIIIIIIIIIII",
    0, 0, 0, 1000, 2000, 0x00010000, 0x01000000, 0, 0, 0, 2, 0,
)
moov = box(b"moov", box(b"mvhd", mvhd))
mdat = box(b"mdat", b"")
for cam in cameras:
    path = os.path.join(out_dir, cam + ".mp4")
    with open(path, "wb") as handle:
        handle.write(ftyp + moov + mdat)
    print("placeholder", os.path.basename(path))
PY
write_manifest placeholder
print_sizes_and_budget
exit 0
