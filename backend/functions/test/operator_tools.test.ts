import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createDeliveryServices } from "../src/delivery";
import { REQUIRED_CAMERA_IDS } from "../src/config";
import { HAS_FIRESTORE_EMULATOR, clearParty, createEmulatorContext, disposeEmulatorContext, randomPartyId } from "./support/emulators";

const PACKAGE_ROOT = process.cwd();
const ASSETS = resolve(PACKAGE_ROOT, "../../apps/tv_app/assets");
const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "demo-halloween-tv";
const BUCKET = process.env.STORAGE_BUCKET ?? `${PROJECT_ID}.appspot.com`;
const HAS_EMULATORS = HAS_FIRESTORE_EMULATOR && Boolean(process.env.STORAGE_EMULATOR_HOST);
const IS_LINUX_X64 = process.platform === "linux" && process.arch === "x64";

type ToolResult = { status: number | null; stdout: string; stderr: string };

function runTool(script: string, args: string[], env: NodeJS.ProcessEnv, cwd = PACKAGE_ROOT): ToolResult {
  const result = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["FIRESTORE_EMULATOR_HOST", "STORAGE_EMULATOR_HOST", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT",
    "STORAGE_BUCKET", "PILOT_PARTY_ID", "PILOT_DEVICE_ID", "PILOT_CHANNEL_ID", "FFMPEG_PATH", "FFPROBE_PATH"]) {
    delete env[name];
  }
  return env;
}

function emulatorEnv(partyId: string, deviceId = "tv-pilot", channelId = "haunted_surveillance"): NodeJS.ProcessEnv {
  return {
    ...cleanEnv(),
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST!,
    STORAGE_EMULATOR_HOST: process.env.STORAGE_EMULATOR_HOST!,
    GCLOUD_PROJECT: PROJECT_ID,
    STORAGE_BUCKET: BUCKET,
    PILOT_PARTY_ID: partyId,
    PILOT_DEVICE_ID: deviceId,
    PILOT_CHANNEL_ID: channelId,
  };
}

/** Refusal tests only need the emulator variables present, not a live emulator. */
function fakeEmulatorEnv(projectId = "real-project-12345"): NodeJS.ProcessEnv {
  return {
    ...cleanEnv(),
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    STORAGE_EMULATOR_HOST: "127.0.0.1:9199",
    GCLOUD_PROJECT: projectId,
    STORAGE_BUCKET: `${projectId}.appspot.com`,
  };
}

function lastJson(stdout: string): Record<string, any> {
  const lines = stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length > 0, "tool produced no JSON output");
  return JSON.parse(lines[lines.length - 1]) as Record<string, any>;
}

function probeFixture(path: string): void {
  const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
  const result = spawnSync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=codec_name,pix_fmt,r_frame_rate,width,height:format=duration", "-of", "json", path], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout) as { streams: Array<Record<string, unknown>>; format: { duration: string } };
  assert.equal(metadata.streams[0].codec_name, "h264");
  assert.equal(metadata.streams[0].pix_fmt, "yuv420p");
  assert.equal(metadata.streams[0].r_frame_rate, "24/1");
  assert.equal(metadata.streams[0].width, 960);
  assert.equal(metadata.streams[0].height, 540);
  assert.equal(Math.round(Number(metadata.format.duration) * 1000), 2000);
}

function fixtureManifest(): { clips: Array<{ cameraId: string; sha256: string; sizeBytes: number }> } {
  return JSON.parse(readFileSync(join(ASSETS, "fixture_manifest.json"), "utf8")) as { clips: Array<{ cameraId: string; sha256: string; sizeBytes: number }> };
}

test("operator tools refuse missing, mixed, and implicit cloud targets", () => {
  const missing = runTool("tools/seed_pilot.ts", ["--target=emulator", "--apply"], cleanEnv());
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /both FIRESTORE_EMULATOR_HOST and STORAGE_EMULATOR_HOST/);

  const mixedEnv = cleanEnv();
  mixedEnv.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  mixedEnv.STORAGE_BUCKET = BUCKET;
  const mixed = runTool("tools/seed_pilot.ts", ["--target=emulator", "--apply"], mixedEnv);
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /partial emulator target/);

  const implicitCloud = runTool("tools/seed_pilot.ts", ["--project=real-project-12345", "--bucket=real-project-12345.appspot.com", "--apply"], cleanEnv());
  assert.notEqual(implicitCloud.status, 0);
  assert.match(implicitCloud.stderr, /explicit --target=emulator or --target=cloud/);

  const cloudWithoutFlags = runTool("tools/seed_pilot.ts", ["--target=cloud", "--apply"], cleanEnv());
  assert.notEqual(cloudWithoutFlags.status, 0);
  assert.match(cloudWithoutFlags.stderr, /explicit --project=PROJECT and --bucket=BUCKET/);

  const cloudWithEmulator = runTool("tools/seed_pilot.ts", ["--target=cloud", "--project=real-project-12345",
    "--bucket=real-project-12345.appspot.com", "--apply"], fakeEmulatorEnv());
  assert.notEqual(cloudWithEmulator.status, 0);
  assert.match(cloudWithEmulator.stderr, /Cloud seeding refuses emulator environment variables/);

  const reconcileImplicit = runTool("tools/reconcile_usage.ts", [], cleanEnv());
  assert.notEqual(reconcileImplicit.status, 0);
  assert.match(reconcileImplicit.stderr, /explicit --target=cloud or --target=emulator/);

  const preflightImplicit = runTool("tools/deploy_preflight.ts", ["--project=" + PROJECT_ID], cleanEnv());
  assert.notEqual(preflightImplicit.status, 0);
  assert.match(preflightImplicit.stderr, /--target=cloud or --target=emulator/);
});

test("delivery verification refuses unsafe targets and exits nonzero on a failed endpoint", () => {
  const noAck = runTool("tools/verify_delivery.ts", ["--target=emulator", "--emulator-service-substitute"], fakeEmulatorEnv());
  assert.notEqual(noAck.status, 0);
  assert.match(noAck.stderr, /--ack-and-purge/);

  const noSubstitute = runTool("tools/verify_delivery.ts", ["--target=emulator", "--ack-and-purge"], fakeEmulatorEnv());
  assert.notEqual(noSubstitute.status, 0);
  assert.match(noSubstitute.stderr, /--emulator-service-substitute/);

  const cloudWithEmulator = runTool("tools/verify_delivery.ts", ["--target=cloud", "--ack-and-purge",
    "--project=real-project-12345", "--bucket=real-project-12345.appspot.com"], fakeEmulatorEnv());
  assert.notEqual(cloudWithEmulator.status, 0);
  assert.match(cloudWithEmulator.stderr, /Cloud verification refuses emulator hosts/);

  const substituteInCloud = runTool("tools/verify_delivery.ts", ["--target=cloud", "--ack-and-purge", "--emulator-service-substitute",
    "--project=real-project-12345", "--bucket=real-project-12345.appspot.com", "--functions-url=https://us-central1-real-project-12345.cloudfunctions.net",
    "--party=pilot", "--device=tv-pilot", "--channel=haunted_surveillance"], cleanEnv());
  assert.notEqual(substituteInCloud.status, 0);
  assert.match(substituteInCloud.stderr, /substitute is forbidden for cloud/);

  const unreachable = runTool("tools/verify_delivery.ts", ["--target=emulator", "--ack-and-purge", "--emulator-service-substitute",
    "--functions-url=http://127.0.0.1:1/demo/us-central1", "--party=pilot", "--device=tv-pilot", "--channel=haunted_surveillance",
    "--output-dir=" + mkdtempSync(join(tmpdir(), "p4-verify-fail-"))], fakeEmulatorEnv());
  assert.notEqual(unreachable.status, 0);
  assert.match(unreachable.stderr, /failed|fetch|ECONNREFUSED/i);

  const conflict = runTool("tools/verify_delivery.ts", ["--target=cloud", "--observe-only", "--ack-and-purge",
    "--project=real-project-12345", "--bucket=real-project-12345.appspot.com",
    "--functions-url=https://us-central1-real-project-12345.cloudfunctions.net",
    "--party=pilot", "--device=tv-pilot", "--channel=haunted_surveillance"], cleanEnv());
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /never preempts/);
});

test("fake rehearsal previews without network and refuses live, mixed, and implicit selection", () => {
  const base = ["--target=cloud", "--project=real-project-12345",
    "--functions-url=https://us-central1-real-project-12345.cloudfunctions.net",
    "--party=party-12345", "--device=tv-12345", "--channel=haunted_surveillance",
    "--job=rehearsal-job-1", "--provider=fake"];
  const preview = runTool("tools/run_fake_rehearsal.ts", base, cleanEnv());
  assert.equal(preview.status, 0, preview.stderr);
  const plan = lastJson(preview.stdout);
  assert.equal(plan.result, "preview");
  assert.equal(plan.preview, true);
  assert.equal(plan.provider, "fake");
  assert.equal(plan.submits, 1);
  assert.equal(plan.jobId, "rehearsal-job-1");

  const live = runTool("tools/run_fake_rehearsal.ts", base.map((arg) => arg === "--provider=fake" ? "--provider=alibaba" : arg), cleanEnv());
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /live providers are refused/);

  const ambientLive = runTool("tools/run_fake_rehearsal.ts", base,
    { ...cleanEnv(), VIDEO_GENERATION_PROVIDER: "alibaba" });
  assert.notEqual(ambientLive.status, 0);
  assert.match(ambientLive.stderr, /refuses ambient VIDEO_GENERATION_PROVIDER/);

  const missing = base.filter((arg) => !arg.startsWith("--job="));
  const implicit = runTool("tools/run_fake_rehearsal.ts", [...missing, "--apply"], cleanEnv());
  assert.notEqual(implicit.status, 0);
  assert.match(implicit.stderr, /nothing is inferred/);

  const mixed = runTool("tools/run_fake_rehearsal.ts", [...base, "--apply"],
    { ...cleanEnv(), FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" });
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /mixed emulator\/cloud targets/);

  const http = runTool("tools/run_fake_rehearsal.ts", base.map((arg) =>
    arg.startsWith("--functions-url=") ? "--functions-url=http://us-central1-real-project-12345.cloudfunctions.net" : arg),
  cleanEnv());
  assert.notEqual(http.status, 0);
  assert.match(http.stderr, /must use HTTPS/);
});

test("runtime preparation validates the Linux artifact without executing foreign binaries", () => {
  const result = runTool("tools/prepare_runtime.ts", [], cleanEnv());
  assert.equal(result.status, 0, result.stderr);
  const report = lastJson(result.stdout);
  assert.equal(report.prepared, true);
  assert.equal(report.target, "linux-x64");
  const manifestPath = join(PACKAGE_ROOT, "runtime", "runtime-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    target: string; validationMode: string; smokeTested: boolean; structuralOnly: boolean;
    binaries: { ffmpegSha256: string; ffprobeSha256: string; ffmpegBytes: number; ffprobeBytes: number };
    fixtures: Array<{ cameraId: string; sha256: string; sizeBytes: number }>;
  };
  assert.equal(manifest.target, "linux-x64");
  if (IS_LINUX_X64) {
    assert.equal(manifest.validationMode, "executed");
    assert.equal(manifest.smokeTested, true);
  } else {
    // Cross-host: structural-only, never executed, smokeTested never true.
    assert.equal(manifest.validationMode, "structural-only");
    assert.equal(manifest.smokeTested, false);
    assert.equal(manifest.structuralOnly, true);
    assert.match(result.stderr, /structural-only/);
  }
  for (const name of ["ffmpeg", "ffprobe"] as const) {
    const bytes = readFileSync(join(PACKAGE_ROOT, "runtime", "bin", name));
    assert.equal(bytes[0], 0x7f, `${name} is not an ELF binary`);
    assert.equal(bytes.toString("ascii", 1, 4), "ELF");
    assert.equal(bytes.readUInt16LE(18), 62, `${name} is not x86-64`);
  }
  const key = (name: string): string => name === "ffmpeg" ? manifest.binaries.ffmpegSha256 : manifest.binaries.ffprobeSha256;
  for (const name of ["ffmpeg", "ffprobe"]) {
    const original = readFileSync(join(PACKAGE_ROOT, "node_modules", name === "ffmpeg" ? "@ffmpeg-installer" : "@ffprobe-installer", "linux-x64", name));
    assert.equal(createHash("sha256").update(original).digest("hex"), key(name), `packaged ${name} diverges from the pinned package bytes`);
  }
  const expected = fixtureManifest();
  assert.equal(manifest.fixtures.length, 4);
  for (const clip of manifest.fixtures) {
    const want = expected.clips.find((entry) => entry.cameraId === clip.cameraId)!;
    assert.equal(clip.sha256, want.sha256, `packaged fixture hash drift for ${clip.cameraId}`);
    assert.equal(clip.sizeBytes, want.sizeBytes);
  }
});

type ArtifactOptions = { timeoutSeconds?: number; omitFixture?: string; stripFixtureBinding?: boolean; omitRuntime?: boolean };

/**
 * Builds an isolated deployable artifact from the ACTUAL compiled production
 * modules (copies of lib/src, the real src/normalize.ts marker source, the
 * real package.json entry point shape, and the packaged runtime/ bytes).
 * Nothing is hand-written: the composition checks run against the genuine
 * compiled index.js, and no repository asset directory is reachable from the
 * isolated fixture set.
 */
function buildArtifact(options: ArtifactOptions = {}): { root: string; functions: string } {
  const root = mkdtempSync(join(tmpdir(), "p4-preflight-"));
  const functions = join(root, "functions");
  const copyTree = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) copyTree(join(from, entry.name), join(to, entry.name));
      else copyFileSync(join(from, entry.name), join(to, entry.name));
    }
  };
  copyTree(join(PACKAGE_ROOT, "lib", "src"), join(functions, "lib", "src"));
  mkdirSync(join(functions, "src"), { recursive: true });
  copyFileSync(join(PACKAGE_ROOT, "src", "normalize.ts"), join(functions, "src", "normalize.ts"));
  if (options.stripFixtureBinding) {
    // Corrupt the composition binding the way a regressed build would: the
    // packaged fixture directory is no longer passed to the runtime factory.
    const indexPath = join(functions, "lib", "src", "index.js");
    const compiled = readFileSync(indexPath, "utf8").replace(/runtime\/fixtures/g, "apps\/tv_app\/assets");
    writeFileSync(indexPath, compiled);
  }
  if (options.timeoutSeconds !== undefined) {
    const indexPath = join(functions, "lib", "src", "index.js");
    const compiled = readFileSync(indexPath, "utf8").replace(/timeoutSeconds:\s*\d+/, `timeoutSeconds: ${options.timeoutSeconds}`);
    writeFileSync(indexPath, compiled);
  }
  writeFileSync(join(functions, "package.json"), JSON.stringify({ name: "artifact", main: "lib/src/index.js", engines: { node: "22" } }, null, 2));
  writeFileSync(join(root, "firebase.json"), JSON.stringify({
    functions: { source: "functions", runtime: "nodejs22", predeploy: ["npm --prefix \"$RESOURCE_DIR\" run predeploy"] },
  }, null, 2));

  mkdirSync(join(functions, "runtime", "bin"), { recursive: true });
  mkdirSync(join(functions, "runtime", "fixtures"), { recursive: true });
  const manifest = fixtureManifest();
  const fixtures: Array<Record<string, unknown>> = [];
  for (const clip of manifest.clips) {
    const name = `cam${clip.cameraId.slice(-2).toLowerCase()}.mp4`;
    copyFileSync(join(PACKAGE_ROOT, "runtime", "fixtures", name), join(functions, "runtime", "fixtures", name));
    fixtures.push({
      cameraId: clip.cameraId, path: `runtime/fixtures/${name}`, sha256: clip.sha256,
      sizeBytes: clip.sizeBytes, durationMs: 2000,
    });
  }
  copyFileSync(join(PACKAGE_ROOT, "runtime", "fixtures", "fixture_manifest.json"), join(functions, "runtime", "fixtures", "fixture_manifest.json"));
  if (options.omitFixture) rmSync(join(functions, "runtime", "fixtures", options.omitFixture));

  const linkBinary = (packageName: string, name: string): { path: string; sha256: string; sizeBytes: number } => {
    // Symlink the real packaged bytes: preflight hash-verifies them read-only
    // and never executes them, so identity holds without a 147MB copy.
    // Negative tests MUST rmSync the link before writing a mutation, or the
    // write follows the link into the real pinned package.
    const source = join(PACKAGE_ROOT, "node_modules", "@" + packageName, "linux-x64", name);
    symlinkSync(source, join(functions, "runtime", "bin", name));
    const bytes = readFileSync(source);
    return { path: `runtime/bin/${name}`, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength };
  };
  const ffmpeg = linkBinary("ffmpeg-installer", "ffmpeg");
  const ffprobe = linkBinary("ffprobe-installer", "ffprobe");
  if (!options.omitRuntime) {
    writeFileSync(join(functions, "runtime", "runtime-manifest.json"), JSON.stringify({
      target: "linux-x64",
      preparedBy: "tools/prepare_runtime.ts",
      validationMode: IS_LINUX_X64 ? "executed" : "structural-only",
      smokeTested: IS_LINUX_X64,
      binaries: {
        ffmpegPath: ffmpeg.path, ffprobePath: ffprobe.path, ffmpegVersion: "4.1.0", ffprobeVersion: "5.2.0",
        ffmpegSha256: ffmpeg.sha256, ffprobeSha256: ffprobe.sha256, ffmpegBytes: ffmpeg.sizeBytes, ffprobeBytes: ffprobe.sizeBytes,
      },
      fixtureDirectory: "runtime/fixtures",
      fixtures,
      normalization: { codec: "h264", pixelFormat: "yuv420p", frameRate: "24/1", width: 854, height: 480, durationMs: 2000 },
      runtimeBytes: ffmpeg.sizeBytes + ffprobe.sizeBytes,
    }, null, 2));
  }
  return { root, functions };
}

function preflightEnv(): NodeJS.ProcessEnv {
  return {
    ...cleanEnv(),
    STORAGE_BUCKET: "artifact-bucket-123456",
    PREFLIGHT_BUCKET_LOCATION: "us-east1",
    VIDEO_GENERATION_PROVIDER: "fake",
    FFMPEG_PATH: "runtime/bin/ffmpeg",
    FFPROBE_PATH: "runtime/bin/ffprobe",
    GENERATION_WORKER_TIMEOUT_SECONDS: "900",
    PROVIDER_POLL_TIMEOUT_SECONDS: "720",
    NORMALIZATION_HEADROOM_SECONDS: "120",
  };
}

function runPreflightOn(artifact: { root: string; functions: string }, project = "artifact-project-12345"): ToolResult {
  return runTool("tools/deploy_preflight.ts", ["--target=cloud", `--project=${project}`,
    "--bucket=artifact-bucket-123456", `--functions-root=${artifact.functions}`, `--config-root=${artifact.root}`], preflightEnv());
}

test("preflight passes a complete artifact and rejects each missing prerequisite", () => {
  const complete = buildArtifact();
  const passed = runPreflightOn(complete);
  assert.equal(passed.status, 0, passed.stderr);
  const report = lastJson(passed.stdout);
  assert.equal(report.preflight, "passed");
  assert.equal(report.target, "cloud");
  assert.equal(report.fixtureDirectory, "runtime/fixtures");
  assert.equal(report.workerTimeoutSeconds, 900);
  assert.equal(report.runtimeValidationMode, IS_LINUX_X64 ? "executed" : "structural-only");

  const shortDeadline = buildArtifact({ timeoutSeconds: 600 });
  const deadlineResult = runPreflightOn(shortDeadline);
  assert.notEqual(deadlineResult.status, 0);
  assert.match(deadlineResult.stderr, /timeoutSeconds=600 does not match GENERATION_WORKER_TIMEOUT_SECONDS=900/);

  const missingFixture = buildArtifact({ omitFixture: "cam03.mp4" });
  const fixtureResult = runPreflightOn(missingFixture);
  assert.notEqual(fixtureResult.status, 0);
  assert.match(fixtureResult.stderr, /Prepared runtime fixture is missing: runtime\/fixtures\/cam03\.mp4/);

  const unwired = buildArtifact({ stripFixtureBinding: true });
  const unwiredResult = runPreflightOn(unwired);
  assert.notEqual(unwiredResult.status, 0);
  assert.match(unwiredResult.stderr, /does not pass the packaged runtime\/fixtures directory/);

  const noRuntime = buildArtifact({ omitRuntime: true });
  const runtimeResult = runPreflightOn(noRuntime);
  assert.notEqual(runtimeResult.status, 0);
  assert.match(runtimeResult.stderr, /Prepared runtime manifest is missing/);

  const truncated = buildArtifact();
  rmSync(join(truncated.functions, "runtime", "bin", "ffmpeg"));
  writeFileSync(join(truncated.functions, "runtime", "bin", "ffmpeg"), Buffer.alloc(1024, 0));
  const truncatedResult = runPreflightOn(truncated);
  assert.notEqual(truncatedResult.status, 0);
  assert.match(truncatedResult.stderr, /unexpectedly small|not a little-endian/);

  const wrongArch = buildArtifact();
  const archSource = join(wrongArch.functions, "runtime", "bin", "ffprobe");
  const archBytes = readFileSync(archSource);
  archBytes[4] = 1; // ELFCLASS32: structurally not the 64-bit target
  rmSync(archSource);
  writeFileSync(archSource, archBytes);
  const archResult = runPreflightOn(wrongArch);
  assert.notEqual(archResult.status, 0);
  assert.match(archResult.stderr, /not a little-endian Linux x86_64 ELF/);

  const hashed = buildArtifact();
  const fixtureBytes = readFileSync(join(hashed.functions, "runtime", "fixtures", "cam02.mp4"));
  fixtureBytes[fixtureBytes.length - 1] ^= 0xff;
  writeFileSync(join(hashed.functions, "runtime", "fixtures", "cam02.mp4"), fixtureBytes);
  const hashResult = runPreflightOn(hashed);
  assert.notEqual(hashResult.status, 0);
  assert.match(hashResult.stderr, /does not match its bytes for CAM-02/);

  const corrupt = buildArtifact();
  writeFileSync(join(corrupt.functions, "runtime", "fixtures", "cam04.mp4"), "plain text, not an mp4 container");
  const corruptResult = runPreflightOn(corrupt);
  assert.notEqual(corruptResult.status, 0);
  assert.match(corruptResult.stderr, /not an MP4 file/);

  const profile = buildArtifact();
  const manifestPath = join(profile.functions, "runtime", "runtime-manifest.json");
  const manifestJson = JSON.parse(readFileSync(manifestPath, "utf8")) as { normalization: Record<string, unknown> };
  manifestJson.normalization = { ...manifestJson.normalization, width: 640 };
  writeFileSync(manifestPath, JSON.stringify(manifestJson));
  const profileResult = runPreflightOn(profile);
  assert.notEqual(profileResult.status, 0);
  assert.match(profileResult.stderr, /normalization profile disagrees.*on width/);

  const lie = buildArtifact();
  const liePath = join(lie.functions, "runtime", "runtime-manifest.json");
  const lieJson = JSON.parse(readFileSync(liePath, "utf8")) as Record<string, unknown>;
  lieJson.smokeTested = true;
  lieJson.validationMode = "structural-only";
  writeFileSync(liePath, JSON.stringify(lieJson));
  const lieResult = runPreflightOn(lie);
  assert.notEqual(lieResult.status, 0);
  assert.match(lieResult.stderr, /smokeTested=true without executed validation/);

  const enabledWithoutOptIn = runTool("tools/deploy_preflight.ts",
    ["--target=cloud", "--project=artifact-project-12345", "--bucket=artifact-bucket-123456",
      `--functions-root=${complete.functions}`, `--config-root=${complete.root}`],
    { ...preflightEnv(), GENERATION_ENABLED: "true" });
  assert.notEqual(enabledWithoutOptIn.status, 0);
  assert.match(enabledWithoutOptIn.stderr, /refuses GENERATION_ENABLED=true/);

  const liveProvider = runTool("tools/deploy_preflight.ts",
    ["--target=cloud", "--project=artifact-project-12345", "--bucket=artifact-bucket-123456", "--allow-generation",
      `--functions-root=${complete.functions}`, `--config-root=${complete.root}`],
    { ...preflightEnv(), GENERATION_ENABLED: "true", VIDEO_GENERATION_PROVIDER: "alibaba" });
  assert.notEqual(liveProvider.status, 0);
  assert.match(liveProvider.stderr, /only the fake provider|VIDEO_GENERATION_PROVIDER=fake/);

  const demoCloud = runPreflightOn(complete, "demo-artifact-123456");
  assert.notEqual(demoCloud.status, 0);
  assert.match(demoCloud.stderr, /cannot be a cloud deployment target/);

  for (const artifact of [complete, shortDeadline, missingFixture, unwired, noRuntime, truncated, wrongArch, hashed, corrupt, profile, lie]) {
    rmSync(artifact.root, { recursive: true, force: true });
  }
});

test("preflight pins the storage trigger to the deploy bucket region", () => {
  // The compiled production trigger must carry an explicit region: the deploy
  // bucket lives in us-east1 while functions default to us-central1.
  const indexSource = readFileSync(join(PACKAGE_ROOT, "src", "index.ts"), "utf8");
  assert.match(indexSource, /onObjectFinalized\(\{\s*bucket:[^}]*region:\s*STORAGE_TRIGGER_REGION/);
  const configSource = readFileSync(join(PACKAGE_ROOT, "src", "config.ts"), "utf8");
  assert.match(configSource, /STORAGE_TRIGGER_REGION\s*=\s*["']us-east1["']/);

  // Matching trigger region passes, including the uppercase location casing
  // returned by the live Storage API.
  const matching = buildArtifact();
  try {
    const passed = runPreflightOn(matching);
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(lastJson(passed.stdout).preflight, "passed");
    const uppercased = runTool("tools/deploy_preflight.ts",
      ["--target=cloud", "--project=artifact-project-12345", "--bucket=artifact-bucket-123456",
        `--functions-root=${matching.functions}`, `--config-root=${matching.root}`],
      { ...preflightEnv(), PREFLIGHT_BUCKET_LOCATION: "US-EAST1" });
    assert.equal(uppercased.status, 0, uppercased.stderr);
  } finally {
    rmSync(matching.root, { recursive: true, force: true });
  }

  // Mismatched trigger region fails with an actionable message.
  const mismatched = buildArtifact();
  try {
    const configPath = join(mismatched.functions, "lib", "src", "config.js");
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace(/us-east1/, "us-central1"));
    const rejected = runPreflightOn(mismatched);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Storage trigger region us-central1 does not match deploy bucket artifact-bucket-123456 location us-east1/);
  } finally {
    rmSync(mismatched.root, { recursive: true, force: true });
  }
});

test("pilot seed stores playable bytes, is idempotent, and refuses newer or purged state", {
  skip: !HAS_EMULATORS ? "requires both emulator targets" : false,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-pilot";
  const channelId = "haunted_surveillance";
  const env = emulatorEnv(partyId, deviceId, channelId);
  const manifestRef = db.doc(`parties/${partyId}/manifests/current_${channelId}`);
  const jobRef = db.doc(`parties/${partyId}/jobs/pilot-fixture-v1`);
  try {
    const preview = runTool("tools/seed_pilot.ts", ["--target=emulator"], env);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(lastJson(preview.stdout).result, "preview");
    assert.equal((await manifestRef.get()).exists, false, "preview must not write a manifest");

    const first = runTool("tools/seed_pilot.ts", ["--target=emulator", "--apply"], env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(lastJson(first.stdout).result, "seeded");
    const manifest = (await manifestRef.get()).data()!;
    const job = (await jobRef.get()).data()!;
    const expected = fixtureManifest();
    assert.equal(manifest.version, 1);
    assert.equal(manifest.schemaVersion, 1);
    assert.ok(manifest.createdAt, "published manifest has no createdAt");
    assert.equal(manifest.jobId, "pilot-fixture-v1");
    assert.equal(job.state, "ready");
    assert.ok(job.createdAt);
    assert.ok(job.expiresAt);
    assert.deepEqual(job.deliveryPaths, manifest.cameraClips.map((clip: { objectPath: string }) => clip.objectPath));
    assert.deepEqual(manifest.cameraClips.map((clip: { cameraId: string }) => clip.cameraId), [...REQUIRED_CAMERA_IDS]);
    for (const clip of manifest.cameraClips as Array<{ cameraId: string; objectPath: string; sha256: string; sizeBytes: number; durationMs: number; expiresAt: string }>) {
      const expectedClip = expected.clips.find((entry) => entry.cameraId === clip.cameraId)!;
      const [bytes] = await bucket.file(clip.objectPath).download();
      assert.equal(bytes.toString("ascii", 4, 8), "ftyp", `${clip.cameraId} is not an MP4 container`);
      assert.equal(bytes.byteLength, expectedClip.sizeBytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedClip.sha256);
      assert.equal(clip.sha256, expectedClip.sha256);
      assert.equal(clip.sizeBytes, expectedClip.sizeBytes);
      assert.equal(clip.durationMs, 2000);
      assert.equal(clip.expiresAt, manifest.expiresAt);
      const [metadata] = await bucket.file(clip.objectPath).getMetadata();
      assert.equal(metadata.contentType, "video/mp4");
      assert.equal(metadata.metadata?.expiresAt, manifest.expiresAt);
      assert.equal(metadata.metadata?.jobId, "pilot-fixture-v1");
      assert.equal(metadata.metadata?.cameraId, clip.cameraId);
      assert.equal(metadata.metadata?.purpose, "delivery");
      probeFixture(join(ASSETS, `cam${clip.cameraId.slice(-2).toLowerCase()}.mp4`));
    }

    const second = runTool("tools/seed_pilot.ts", ["--target=emulator", "--apply"], env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(lastJson(second.stdout).result, "already-seeded");
    assert.equal((await manifestRef.get()).data()?.expiresAt, manifest.expiresAt, "repeat seeding rewrote publication metadata");

    await manifestRef.set({ ...manifest, version: 2, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const newer = runTool("tools/seed_pilot.ts", ["--target=emulator", "--apply"], env);
    assert.notEqual(newer.status, 0);
    assert.match(newer.stderr, /newer or unrelated/);
    assert.equal((await manifestRef.get()).data()?.version, 2, "seeder must not replace a newer manifest");

    const service = createDeliveryServices({ db, bucket, signReadUrl: async () => "https://test.invalid/not-used" });
    const clipHashes = Object.fromEntries(manifest.cameraClips.map((clip: { cameraId: string; sha256: string }) => [clip.cameraId, clip.sha256]));
    await manifestRef.set(manifest);
    const ackInput = { partyId, deviceId, channelId, manifestVersion: 1, clipHashes };
    // Accept while the manifest is current; the retry below proves the
    // persisted ACK record finishes the bounded purge after manifest loss
    // (a first ACK with no current manifest stays rejected per contract).
    await service.acknowledgeDelivery(ackInput);
    await manifestRef.delete();
    const ack = await service.acknowledgeDelivery(ackInput);
    assert.equal(ack.purged, true);
    assert.equal((await jobRef.get()).data()?.state, "purged");
    for (const clip of manifest.cameraClips) {
      assert.equal((await bucket.file(clip.objectPath).exists())[0], false);
    }
    const afterPurge = runTool("tools/seed_pilot.ts", ["--target=emulator", "--apply"], env);
    assert.equal(afterPurge.status, 0, afterPurge.stderr);
    assert.equal(lastJson(afterPurge.stdout).result, "already-purged");
    assert.equal((await jobRef.get()).data()?.state, "purged");
    assert.equal((await manifestRef.get()).exists, false, "a purged pilot must not be resurrected");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("delivery verification downloads, ACKs, purges, and keeps retained files", {
  skip: !HAS_EMULATORS ? "requires both emulator targets" : false,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const outputDirectory = mkdtempSync(join(tmpdir(), "p4-verify-ok-"));
  try {
    const seeded = runTool("tools/seed_pilot.ts", ["--target=emulator", "--apply"], emulatorEnv(partyId));
    assert.equal(seeded.status, 0, seeded.stderr);
    const verified = runTool("tools/verify_delivery.ts", ["--target=emulator", "--emulator-service-substitute", "--ack-and-purge",
      `--project=${PROJECT_ID}`, `--bucket=${BUCKET}`, `--party=${partyId}`, "--device=tv-pilot",
      "--channel=haunted_surveillance", `--output-dir=${outputDirectory}`], emulatorEnv(partyId));
    assert.equal(verified.status, 0, verified.stderr);
    const report = lastJson(verified.stdout);
    assert.equal(report.verification, "passed");
    assert.equal(report.downloadedCameraIds.length, 4);
    assert.equal(report.repeatAckIdempotent, true);
    assert.equal(report.jobState, "purged");
    assert.equal(report.deliveryObjectsAbsent, true);
    assert.equal(report.retainedFilesReadableAfterPurge, true);
    assert.match(String(report.urlMode), /test-only/);

    const manifest = (await db.doc(`parties/${partyId}/manifests/current_haunted_surveillance`).get()).data()!;
    for (const clip of manifest.cameraClips as Array<{ cameraId: string; objectPath: string; sha256: string; sizeBytes: number }>) {
      const retained = readFileSync(join(outputDirectory, `${clip.cameraId}.mp4`));
      assert.equal(retained.byteLength, clip.sizeBytes);
      assert.equal(createHash("sha256").update(retained).digest("hex"), clip.sha256);
      probeFixture(join(outputDirectory, `${clip.cameraId}.mp4`));
    }
    const ack = (await db.doc(`parties/${partyId}/deliveryAcks/${report.ackId}`).get()).data();
    assert.equal(ack?.manifestVersion, 1);
    assert.equal(ack?.deviceId, "tv-pilot");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("delivery verification exits nonzero when downloaded bytes do not match the manifest", {
  skip: !HAS_EMULATORS ? "requires both emulator targets" : false,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    const seeded = runTool("tools/seed_pilot.ts", ["--target=emulator", "--apply"], emulatorEnv(partyId));
    assert.equal(seeded.status, 0, seeded.stderr);
    const manifestRef = db.doc(`parties/${partyId}/manifests/current_haunted_surveillance`);
    const manifest = (await manifestRef.get()).data()!;
    const tampered = structuredClone(manifest);
    tampered.cameraClips[0].sha256 = "0".repeat(64);
    await manifestRef.set(tampered);
    const outputDirectory = mkdtempSync(join(tmpdir(), "p4-verify-bad-"));
    const verified = runTool("tools/verify_delivery.ts", ["--target=emulator", "--emulator-service-substitute", "--ack-and-purge",
      `--project=${PROJECT_ID}`, `--bucket=${BUCKET}`, `--party=${partyId}`, "--device=tv-pilot",
      "--channel=haunted_surveillance", `--output-dir=${outputDirectory}`], emulatorEnv(partyId));
    assert.notEqual(verified.status, 0);
    assert.match(verified.stderr, /failed independent hash\/size verification/);
    assert.equal((await db.doc(`parties/${partyId}/jobs/pilot-fixture-v1`).get()).data()?.state, "ready",
      "a failed verification must not purge delivery objects");
    rmSync(outputDirectory, { recursive: true, force: true });
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("fake dry run proves delivery, purge, retention, and cost-log reconciliation", {
  skip: !HAS_EMULATORS ? "requires both emulator targets" : false,
}, () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "p4-dry-run-"));
  try {
    const result = runTool("tools/run_dry_run.ts", ["--target=emulator", `--output-dir=${outputDirectory}`], emulatorEnv("unused"));
    assert.equal(result.status, 0, result.stderr);
    const report = lastJson(result.stdout);
    assert.equal(report.mode, "fake-emulator-e2e");
    assert.equal(report.billableCalls, 0);
    assert.equal(report.networkGenerationCalls, 0);
    assert.equal(report.downloadedAndHashed, 4);
    assert.equal(report.jobStateAfterAck, "purged");
    assert.equal(report.deliveryObjectsAbsent, true);
    assert.equal(report.retainedFilesReadableAfterPurge, true);
    assert.equal(report.reconcileIssueCountBeforeDelivery, 0);
    assert.equal(report.reconcileIssueCountAfterDelivery, 0);
    assert.equal(report.usageRows.length, 4);
    for (const row of report.usageRows) {
      assert.equal(row.success, true);
      assert.equal(row.credits, "synthetic zero");
      assert.match(row.providerTaskId, new RegExp(`^${row.cameraId}__[a-f0-9]{24}$`));
    }
    assert.equal(report.ttlOrphanSweep.expiredJobState, "expired");
    assert.ok(report.ttlOrphanSweep.deletedExpiredObjects >= 1);
    assert.ok(report.ttlOrphanSweep.deletedOrphanObjects >= 1);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});
