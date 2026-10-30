/**
 * Packages the reproducible Linux x64 FFmpeg/ffprobe binaries and the four
 * offline fake-provider MP4 fixtures inside the Functions artifact.
 *
 * Output (git-ignored, uploaded with the Functions source):
 *   runtime/bin/ffmpeg
 *   runtime/bin/ffprobe
 *   runtime/fixtures/cam01..cam04.mp4 + fixture_manifest.json
 *   runtime/runtime-manifest.json  (consumed by tools/deploy_preflight.ts)
 *
 * The prepared paths are the contract with the Functions runtime factory:
 * `FFMPEG_PATH`/`FFPROBE_PATH` are read by src/normalize.ts and the packaged
 * fixture directory (`runtime/fixtures`) must be passed to
 * `new FakeVideoGenerationPort(<dir>)` by the composition root. Nothing here
 * assumes that the repository-relative `apps/tv_app/assets` path survives a
 * deployment.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { REQUIRED_CAMERA_IDS } from "../src/config";

const TARGET = "linux-x64";
const NORMALIZATION = {
  codec: "h264",
  pixelFormat: "yuv420p",
  frameRate: "24/1",
  width: 854,
  height: 480,
  durationMs: 2000,
} as const;
const FIXTURE_PROFILE = {
  codec: "h264",
  pixelFormat: "yuv420p",
  frameRate: "24/1",
  width: 960,
  height: 540,
  durationMs: 2000,
} as const;
const REQUIRED_FFMPEG_FILTERS = ["fps", "scale", "pad", "setsar", "tpad"];
const PINNED_PACKAGES = {
  ffmpeg: { packageName: "@ffmpeg-installer/linux-x64", binary: "ffmpeg", expectedVersion: "4.1.0" },
  ffprobe: { packageName: "@ffprobe-installer/linux-x64", binary: "ffprobe", expectedVersion: "5.2.0" },
} as const;

const packageRoot = process.cwd();
const runtimeRoot = join(packageRoot, "runtime");
const sourceAssets = resolve(packageRoot, "../../apps/tv_app/assets");

type ProbeStream = { codec_name?: string; pix_fmt?: string; r_frame_rate?: string; width?: number; height?: number };
type ProbeResult = { streams?: ProbeStream[]; format?: { duration?: string } };

function fail(message: string): never {
  throw new Error(message);
}

function run(command: string, args: string[], timeout = 120_000): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) fail(`${command} could not be executed: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args[0] ?? ""} failed (${String(result.status)}): ${(result.stderr || "").slice(-2000)}`);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function assertLinuxX64Executable(path: string, label: string): Buffer {
  if (!existsSync(path)) fail(`${label} binary is missing at ${path}.`);
  const bytes = readFileSync(path);
  const isElf = bytes[0] === 0x7f && bytes.toString("ascii", 1, 4) === "ELF";
  const is64BitLittleEndian = bytes[4] === 2 && bytes[5] === 1;
  const machine = bytes.length > 20 ? bytes.readUInt16LE(18) : 0;
  if (!isElf || !is64BitLittleEndian || machine !== 62) {
    fail(`${label} at ${path} is not a little-endian Linux x86_64 ELF executable (target ${TARGET}).`);
  }
  return bytes;
}

function probeMedia(ffprobePath: string, path: string): ProbeResult {
  const { stdout } = run(ffprobePath, [
    "-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=codec_name,pix_fmt,r_frame_rate,width,height:format=duration", "-of", "json", path,
  ], 30_000);
  try {
    return JSON.parse(stdout) as ProbeResult;
  } catch {
    return fail(`ffprobe returned unparseable metadata for ${path}.`);
  }
}

function assertProfile(metadata: ProbeResult, expected: Record<string, unknown>, label: string, path: string): void {
  const video = metadata.streams?.[0];
  const durationMs = Math.round(Number(metadata.format?.duration) * 1000);
  for (const key of ["codec", "pixelFormat", "frameRate", "width", "height", "durationMs"] as const) {
    const actual = key === "codec" ? video?.codec_name
      : key === "pixelFormat" ? video?.pix_fmt
      : key === "frameRate" ? video?.r_frame_rate
      : key === "durationMs" ? durationMs
      : video?.[key];
    if (actual !== expected[key]) {
      fail(`${label} at ${path} does not match the required profile (${key}: expected ${String(expected[key])}, found ${String(actual)}).`);
    }
  }
}

/** Pinned installer packages drop the binary next to their package.json. */
function installedBinary(entry: (typeof PINNED_PACKAGES)[keyof typeof PINNED_PACKAGES]): { path: string; version: string } {
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve(`${entry.packageName}/package.json`);
  } catch {
    fail(`Pinned package ${entry.packageName} is not installed; run npm install in backend/functions with Linux x64 packages included.`);
  }
  const directory = dirname(packageJsonPath);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
  if (packageJson.version !== entry.expectedVersion) {
    fail(`${entry.packageName} resolved to version ${String(packageJson.version)} but ${entry.expectedVersion} is pinned.`);
  }
  const path = join(directory, entry.binary);
  if (!existsSync(path)) fail(`${entry.packageName} did not install its ${entry.binary} binary (expected ${path}).`);
  return { path, version: entry.expectedVersion };
}

function verifyBuildCapabilities(ffmpegPath: string, ffprobePath: string): void {
  const encoders = run(ffmpegPath, ["-hide_banner", "-encoders"], 30_000).stdout;
  if (!/\blibx264\b/.test(encoders)) fail("Packaged FFmpeg has no libx264 encoder; the delivery profile cannot be produced.");
  const filters = run(ffmpegPath, ["-hide_banner", "-filters"], 30_000).stdout;
  const missing = REQUIRED_FFMPEG_FILTERS.filter((name) => !new RegExp(`\\s${name}\\s`).test(filters));
  if (missing.length) fail(`Packaged FFmpeg is missing required filters: ${missing.join(", ")}.`);
  const formats = run(ffmpegPath, ["-hide_banner", "-formats"], 30_000).stdout;
  if (!/\bmp4\b/.test(formats)) fail("Packaged FFmpeg cannot mux MP4 output.");
  run(ffprobePath, ["-hide_banner", "-version"], 30_000);
}

function smokeNormalize(sourcePath: string, ffmpegPath: string, ffprobePath: string): void {
  const outputPath = join(tmpdir(), `halloween-runtime-smoke-${process.pid}.mp4`);
  const filter = "fps=24,scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=2";
  try {
    run(ffmpegPath, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath,
      "-an", "-vf", filter, "-t", "2", "-r", "24", "-c:v", "libx264",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath,
    ]);
    assertProfile(probeMedia(ffprobePath, outputPath), NORMALIZATION, "Normalized smoke output", outputPath);
    if (statSync(outputPath).size <= 0) fail("Normalized smoke output is empty.");
  } finally {
    rmSync(outputPath, { force: true });
  }
}

async function loadFixtures(): Promise<Array<{
  cameraId: string; path: string; sha256: string; sizeBytes: number; durationMs: number;
}>> {
  const manifestPath = join(sourceAssets, "fixture_manifest.json");
  if (!existsSync(manifestPath)) fail(`Repository fixture manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    clips?: Array<{ cameraId: string; sha256: string; sizeBytes: number; durationMs: number }>;
  };
  const clips = manifest.clips;
  if (!Array.isArray(clips) || clips.length !== REQUIRED_CAMERA_IDS.length ||
      REQUIRED_CAMERA_IDS.some((cameraId) => !clips.some((clip) => clip.cameraId === cameraId))) {
    fail("Offline fixture manifest must list exactly CAM-01 through CAM-04.");
  }
  return REQUIRED_CAMERA_IDS.map((cameraId) => {
    const entry = clips.find((clip) => clip.cameraId === cameraId)!;
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0 || entry.durationMs !== 2000) {
      fail(`Fixture manifest metadata is invalid for ${cameraId}.`);
    }
    return {
      cameraId,
      path: join(sourceAssets, `cam${cameraId.slice(-2).toLowerCase()}.mp4`),
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      durationMs: entry.durationMs,
    };
  });
}

async function main(): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail(`Runtime preparation must execute on ${TARGET} to run and capability-test the packaged binaries; this host is ${process.platform}-${process.arch}. Use the Linux CI job or a linux/amd64 container.`);
  }
  const ffmpeg = installedBinary(PINNED_PACKAGES.ffmpeg);
  const ffprobe = installedBinary(PINNED_PACKAGES.ffprobe);
  const ffmpegBytes = assertLinuxX64Executable(ffmpeg.path, "FFmpeg");
  const ffprobeBytes = assertLinuxX64Executable(ffprobe.path, "ffprobe");
  verifyBuildCapabilities(ffmpeg.path, ffprobe.path);

  const fixtures = await loadFixtures();
  const fixtureDirectory = join(runtimeRoot, "fixtures");
  const binDirectory = join(runtimeRoot, "bin");
  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(binDirectory, { recursive: true });
  await mkdir(fixtureDirectory, { recursive: true });

  const ffmpegTarget = join(binDirectory, "ffmpeg");
  const ffprobeTarget = join(binDirectory, "ffprobe");
  await copyFile(ffmpeg.path, ffmpegTarget);
  await copyFile(ffprobe.path, ffprobeTarget);
  await chmod(ffmpegTarget, 0o755);
  await chmod(ffprobeTarget, 0o755);
  assertLinuxX64Executable(ffmpegTarget, "Packaged FFmpeg");
  assertLinuxX64Executable(ffprobeTarget, "Packaged ffprobe");

  const preparedFixtures: Array<Record<string, unknown>> = [];
  for (const fixture of fixtures) {
    const bytes = await readFile(fixture.path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== fixture.sizeBytes || digest !== fixture.sha256) {
      fail(`Repository fixture bytes do not match fixture_manifest.json for ${fixture.cameraId}.`);
    }
    assertProfile(probeMedia(ffprobeTarget, fixture.path), FIXTURE_PROFILE, `Repository fixture ${fixture.cameraId}`, fixture.path);
    const target = join(fixtureDirectory, `cam${fixture.cameraId.slice(-2).toLowerCase()}.mp4`);
    await copyFile(fixture.path, target);
    await chmod(target, 0o644);
    assertProfile(probeMedia(ffprobeTarget, target), FIXTURE_PROFILE, `Packaged fixture ${fixture.cameraId}`, target);
    preparedFixtures.push({
      cameraId: fixture.cameraId,
      path: `runtime/fixtures/cam${fixture.cameraId.slice(-2).toLowerCase()}.mp4`,
      sha256: fixture.sha256,
      sizeBytes: fixture.sizeBytes,
      durationMs: fixture.durationMs,
      profile: FIXTURE_PROFILE,
    });
  }
  await copyFile(join(sourceAssets, "fixture_manifest.json"), join(fixtureDirectory, "fixture_manifest.json"));
  smokeNormalize(join(fixtureDirectory, "cam01.mp4"), ffmpegTarget, ffprobeTarget);

  const runtimeBytes = ffmpegBytes.byteLength + ffprobeBytes.byteLength +
    preparedFixtures.reduce((total, fixture) => total + Number(fixture.sizeBytes), 0);
  const output = {
    target: TARGET,
    preparedBy: "tools/prepare_runtime.ts",
    binaries: {
      ffmpegPath: "runtime/bin/ffmpeg",
      ffprobePath: "runtime/bin/ffprobe",
      ffmpegVersion: ffmpeg.version,
      ffprobeVersion: ffprobe.version,
      ffmpegBytes: ffmpegBytes.byteLength,
      ffprobeBytes: ffprobeBytes.byteLength,
      ffmpegSha256: createHash("sha256").update(ffmpegBytes).digest("hex"),
      ffprobeSha256: createHash("sha256").update(ffprobeBytes).digest("hex"),
    },
    fixtureDirectory: "runtime/fixtures",
    licenses: {
      ffmpeg: { package: "@ffmpeg-installer/linux-x64", license: "GPL-3.0-or-later", notice: "https://ffmpeg.org/legal.html" },
      ffprobe: { package: "@ffprobe-installer/linux-x64", license: "GPL-3.0-or-later", notice: "https://ffmpeg.org/legal.html" },
      note: "Packaged FFmpeg builds are GPL-licensed. Keep this record with the deployment; redistribution requires the corresponding notices and source availability per the license.",
    },
    fixtures: preparedFixtures,
    normalization: NORMALIZATION,
    smokeTested: true,
    runtimeBytes,
  };
  await writeFile(join(runtimeRoot, "runtime-manifest.json"), `${JSON.stringify(output, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`${JSON.stringify({ prepared: true, ...output })}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
