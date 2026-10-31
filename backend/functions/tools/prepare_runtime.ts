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
 *
 * Cross-host behavior:
 * - On linux-x64 the packaged binaries are EXECUTED: build-capability checks
 *   (libx264, required filters, mp4 mux) and a normalization smoke test run
 *   against them. The manifest records validationMode "executed" and
 *   smokeTested true.
 * - On any other host (e.g. darwin-arm64) the Linux binaries are NEVER
 *   executed. Packaging is structural: pinned package versions, ELF64 LE
 *   x86-64 headers, sizes, exec bits, and hashes are validated; fixture
 *   bytes are validated plus profile-probed with the separately selected
 *   NATIVE host ffprobe (never runtime/bin). The manifest records
 *   validationMode "structural-only" and smokeTested false. smokeTested is
 *   never true without execution.
 */
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { REQUIRED_CAMERA_IDS } from "../src/config";
import {
  EXPECTED_NORMALIZATION,
  EXPECTED_SCENARIO_COUNT,
  FIXTURE_PROFILE,
  PACKAGED_SCENARIO_DIR,
  PACKAGED_SCENARIO_REF_DIR,
  PINNED_PACKAGES,
  REQUIRED_FFMPEG_FILTERS,
  RUNTIME_TARGET,
  SCENARIO_CATALOG_FILENAME,
  SCENARIO_CATALOG_VERSION,
  SITUATIONS_CATALOG_VERSION,
  SITUATIONS_FILENAME,
  assertExecutableMode,
  assertLinuxX64Executable,
  assertSafePackagedPath,
  fail,
  installedPackageVersion,
  sha256Hex,
  validateFixtureBytes,
  validateScenarioInventory,
  validateScenarioReferenceBytes,
  type PinnedEntry,
  type ScenarioManifestSection,
  type ValidationMode,
} from "./runtime_artifact";

const NORMALIZATION = EXPECTED_NORMALIZATION;

const packageRoot = process.cwd();
const runtimeRoot = join(packageRoot, "runtime");
const sourceAssets = resolve(packageRoot, "../../apps/tv_app/assets");

type ProbeStream = { codec_name?: string; pix_fmt?: string; r_frame_rate?: string; width?: number; height?: number };
type ProbeResult = { streams?: ProbeStream[]; format?: { duration?: string } };

function run(command: string, args: string[], timeout = 120_000): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) fail(`${command} could not be executed: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args[0] ?? ""} failed (${String(result.status)}): ${(result.stderr || "").slice(-2000)}`);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Probes media with an explicitly selected NATIVE host binary (never a packaged Linux binary on a foreign host). */
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

/** Pinned installer packages drop the binary next to their package.json. Validates version + ELF structurally (no execution). */
function installedBinary(entry: PinnedEntry): { path: string; version: string } {
  const { directory, version } = installedPackageVersion(entry, packageRoot);
  const path = join(directory, entry.binary);
  if (!existsSync(path)) fail(`${entry.packageName} did not install its ${entry.binary} binary (expected ${path}).`);
  assertLinuxX64Executable(path, entry.binary === "ffmpeg" ? "FFmpeg" : "ffprobe");
  return { path, version };
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
  const executingHost = process.platform === "linux" && process.arch === "x64";
  const validationMode: ValidationMode = executingHost ? "executed" : "structural-only";
  if (!executingHost) {
    process.stderr.write(
      `Cross-host packaging on ${process.platform}-${process.arch}: structural-only validation; ` +
        `Linux binaries are never executed on this host.\n`,
    );
  }
  const ffmpeg = installedBinary(PINNED_PACKAGES.ffmpeg);
  const ffprobe = installedBinary(PINNED_PACKAGES.ffprobe);
  const ffmpegBytes = readFileSync(ffmpeg.path);
  const ffprobeBytes = readFileSync(ffprobe.path);
  assertExecutableMode(ffmpeg.path, "FFmpeg");
  assertExecutableMode(ffprobe.path, "ffprobe");

  // Native host probe binary for fixture media checks. This is the operator's
  // own toolchain (FFPROBE_NATIVE_PATH, else PATH `ffprobe`), never a
  // runtime/bin file and never FFPROBE_PATH (which points at the packaged
  // Linux binary in deployment environments), so Linux binaries stay
  // unexecuted on foreign hosts.
  const nativeFfprobe = process.env.FFPROBE_NATIVE_PATH ?? "ffprobe";
  const packagedFfprobeForProbe = executingHost ? ffprobe.path : undefined;
  if (!executingHost && (nativeFfprobe.endsWith("runtime/bin/ffprobe") || nativeFfprobe.endsWith("runtime/bin/ffmpeg"))) {
    fail("Cross-host packaging refuses a runtime/bin probe binary; select a native host ffprobe via FFPROBE_NATIVE_PATH.");
  }

  if (executingHost) {
    verifyBuildCapabilities(ffmpeg.path, ffprobe.path);
  }

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
  // Structural re-validation of the COPIED bytes (read-only, no execution).
  const packagedFfmpegBytes = assertLinuxX64Executable(ffmpegTarget, "Packaged FFmpeg");
  const packagedFfprobeBytes = assertLinuxX64Executable(ffprobeTarget, "Packaged ffprobe");
  assertExecutableMode(ffmpegTarget, "Packaged FFmpeg");
  assertExecutableMode(ffprobeTarget, "Packaged ffprobe");

  const preparedFixtures: Array<Record<string, unknown>> = [];
  for (const fixture of fixtures) {
    const bytes = await readFile(fixture.path);
    validateFixtureBytes(bytes, fixture);
    const probePath = packagedFfprobeForProbe ?? nativeFfprobe;
    try {
      assertProfile(probeMedia(probePath, fixture.path), FIXTURE_PROFILE, `Repository fixture ${fixture.cameraId}`, fixture.path);
    } catch (error) {
      if (!executingHost) {
        fail(
          `Repository fixture ${fixture.cameraId} failed the native-host profile probe ` +
            `(${nativeFfprobe}): ${error instanceof Error ? error.message : String(error)}. ` +
            `Install a working native ffprobe or set FFPROBE_NATIVE_PATH.`,
        );
      }
      throw error;
    }
    const target = join(fixtureDirectory, `cam${fixture.cameraId.slice(-2).toLowerCase()}.mp4`);
    await copyFile(fixture.path, target);
    await chmod(target, 0o644);
    const copied = await readFile(target);
    validateFixtureBytes(copied, fixture);
    const copiedProbePath = packagedFfprobeForProbe ?? nativeFfprobe;
    assertProfile(probeMedia(copiedProbePath, target), FIXTURE_PROFILE, `Packaged fixture ${fixture.cameraId}`, target);
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

  // Cartoon scenario catalog inventory: both versioned JSONs plus all 16
  // reference stills are packaged under runtime/scenarios so a relocated
  // Functions artifact loads every entry without the repository checkout.
  // Every byte is hashed against its catalog record here; the manifest
  // scenario section pins the digests for deploy_preflight.
  const scenarioSection = await (async (): Promise<ScenarioManifestSection> => {
    const catalogRepoPath = join(packageRoot, "assets", SCENARIO_CATALOG_FILENAME);
    const situationsRepoPath = join(packageRoot, "assets", SITUATIONS_FILENAME);
    if (!existsSync(catalogRepoPath)) fail(`Scenario catalog is missing: ${catalogRepoPath}`);
    if (!existsSync(situationsRepoPath)) fail(`Situations catalog is missing: ${situationsRepoPath}`);
    const catalog = JSON.parse(await readFile(catalogRepoPath, "utf8")) as unknown;
    const situations = JSON.parse(await readFile(situationsRepoPath, "utf8")) as unknown;
    const records = validateScenarioInventory(catalog, situations);
    if (records.length !== EXPECTED_SCENARIO_COUNT) {
      fail(`Scenario inventory must hold exactly ${EXPECTED_SCENARIO_COUNT} records.`);
    }
    const scenarioDirectory = join(runtimeRoot, "scenarios");
    const scenarioRefDirectory = join(runtimeRoot, "scenarios", "scenario_refs");
    await mkdir(scenarioDirectory, { recursive: true });
    await mkdir(scenarioRefDirectory, { recursive: true });
    for (const record of records) {
      assertSafePackagedPath(record.referencePath, `Scenario ${record.id} referencePath`);
      const source = join(packageRoot, record.referencePath);
      if (!existsSync(source)) fail(`Scenario ${record.id} reference is missing: ${source}`);
      const bytes = await readFile(source);
      validateScenarioReferenceBytes(bytes, record);
      const target = join(scenarioRefDirectory, record.sourceFilename);
      await copyFile(source, target);
      await chmod(target, 0o644);
      validateScenarioReferenceBytes(await readFile(target), record);
    }
    await copyFile(catalogRepoPath, join(scenarioDirectory, SCENARIO_CATALOG_FILENAME));
    await chmod(join(scenarioDirectory, SCENARIO_CATALOG_FILENAME), 0o644);
    await copyFile(situationsRepoPath, join(scenarioDirectory, SITUATIONS_FILENAME));
    await chmod(join(scenarioDirectory, SITUATIONS_FILENAME), 0o644);
    return {
      catalogVersion: SCENARIO_CATALOG_VERSION,
      situationsVersion: SITUATIONS_CATALOG_VERSION,
      catalogPath: `${PACKAGED_SCENARIO_DIR}/${SCENARIO_CATALOG_FILENAME}`,
      situationsPath: `${PACKAGED_SCENARIO_DIR}/${SITUATIONS_FILENAME}`,
      refDirectory: PACKAGED_SCENARIO_REF_DIR,
      count: records.length,
      records,
    };
  })();

  let smokeTested = false;
  if (executingHost) {
    smokeNormalize(join(fixtureDirectory, "cam01.mp4"), ffmpegTarget, ffprobeTarget);
    smokeTested = true;
  }

  const runtimeBytes = packagedFfmpegBytes.byteLength + packagedFfprobeBytes.byteLength +
    preparedFixtures.reduce((total, fixture) => total + Number(fixture.sizeBytes), 0) +
    scenarioSection.records.reduce((total, record) => total + record.sizeBytes, 0);
  const output = {
    target: RUNTIME_TARGET,
    preparedBy: "tools/prepare_runtime.ts",
    validationMode,
    smokeTested,
    structuralOnly: !executingHost,
    hostPlatform: process.platform,
    hostArch: process.arch,
    nativeProbe: executingHost ? undefined : { ffprobe: nativeFfprobe, note: "repository + packaged fixture profiles probed with the native host ffprobe; packaged Linux binaries never executed" },
    binaries: {
      ffmpegPath: "runtime/bin/ffmpeg",
      ffprobePath: "runtime/bin/ffprobe",
      ffmpegVersion: ffmpeg.version,
      ffprobeVersion: ffprobe.version,
      ffmpegBytes: packagedFfmpegBytes.byteLength,
      ffprobeBytes: packagedFfprobeBytes.byteLength,
      ffmpegSha256: sha256Hex(packagedFfmpegBytes),
      ffprobeSha256: sha256Hex(packagedFfprobeBytes),
    },
    fixtureDirectory: "runtime/fixtures",
    licenses: {
      ffmpeg: { package: "@ffmpeg-installer/linux-x64", license: "GPL-3.0-or-later", notice: "https://ffmpeg.org/legal.html" },
      ffprobe: { package: "@ffprobe-installer/linux-x64", license: "GPL-3.0-or-later", notice: "https://ffmpeg.org/legal.html" },
      note: "Packaged FFmpeg builds are GPL-licensed. Keep this record with the deployment; redistribution requires the corresponding notices and source availability per the license.",
    },
    fixtures: preparedFixtures,
    normalization: NORMALIZATION,
    scenarios: scenarioSection,
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
