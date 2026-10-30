/**
 * Deployment gate for the Hallowe'en TV Functions artifact.
 *
 * Everything is checked against what actually gets uploaded: the compiled
 * entry point (`package.json main`), the prepared runtime artifact
 * (`runtime/`), the resolved environment, and `backend/firebase.json`.
 *
 * Target selection is never inferred: `--target=cloud` is required for a real
 * project, `--target=emulator` is the local dry run. Every failure is
 * reported; the process exits nonzero when any check fails.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REQUIRED_EXPORTS = ["requestGeneration", "runGeneration", "getCurrentManifest", "getDeliveryUrls", "acknowledgeDelivery", "sweepExpiredMedia"];
const EXPECTED_NORMALIZATION = { codec: "h264", pixelFormat: "yuv420p", frameRate: "24/1", width: 854, height: 480, durationMs: 2000 };
const CONFIG_KEYS = new Set([
  "STORAGE_BUCKET", "FFMPEG_PATH", "FFPROBE_PATH", "GENERATION_WORKER_TIMEOUT_SECONDS",
  "PROVIDER_POLL_TIMEOUT_SECONDS", "NORMALIZATION_HEADROOM_SECONDS", "VIDEO_GENERATION_PROVIDER",
  "FIRESTORE_EMULATOR_HOST", "STORAGE_EMULATOR_HOST", "FAKE_FIXTURE_DIR",
  "GENERATION_ENABLED", "PROVIDER_POLL_INTERVAL_MS", "PROVIDER_TIMEOUT_MS",
]);

type RuntimeManifest = {
  target?: string;
  binaries?: {
    ffmpegPath?: string; ffprobePath?: string; ffmpegVersion?: string; ffprobeVersion?: string;
    ffmpegBytes?: number; ffprobeBytes?: number;
  };
  fixtureDirectory?: string;
  fixtures?: Array<{ cameraId: string; path: string; sha256: string; sizeBytes: number; durationMs: number }>;
  normalization?: typeof EXPECTED_NORMALIZATION;
  smokeTested?: boolean;
  runtimeBytes?: number;
};

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function integerSetting(name: string, config: Record<string, string>): number {
  const raw = process.env[name] ?? config[name];
  const value = Number(raw);
  if (!raw || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be an explicit positive integer number of seconds.`);
  }
  return value;
}

async function readEnvironmentFiles(functionsRoot: string, projectId: string): Promise<Record<string, string>> {
  const config: Record<string, string> = {};
  for (const name of [".env", `.env.${projectId}`]) {
    const path = join(functionsRoot, name);
    if (!existsSync(path)) continue;
    for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || !CONFIG_KEYS.has(match[1])) continue;
      const raw = match[2].replace(/^(?:"([^"]*)"|'([^']*)')$/, (_whole, doubleQuoted: string, singleQuoted: string) => doubleQuoted ?? singleQuoted);
      if (raw !== "") config[match[1]] = raw;
    }
  }
  return config;
}

function isLinuxX64Elf(bytes: Buffer): boolean {
  return bytes[0] === 0x7f && bytes.toString("ascii", 1, 4) === "ELF" && bytes[4] === 2 && bytes[5] === 1 &&
    bytes.readUInt16LE(18) === 62;
}

/** Runs the packaged fake provider from inside the artifact with no repository checkout. */
function probePackagedProvider(functionsRoot: string, fixtureDirectory: string): Array<{ cameraId: string; sha256: string; sizeBytes: number }> {
  const script = `
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { FakeVideoGenerationPort } = require("./lib/src/providers/fake.js");
const { REQUIRED_CAMERA_IDS } = require("./lib/src/config.js");
const { buildCheapDemoRequest } = require("./lib/src/video_generation_port.js");
(async () => {
  const provider = new FakeVideoGenerationPort(process.argv[1]);
  const clips = [];
  for (const cameraId of REQUIRED_CAMERA_IDS) {
    const request = buildCheapDemoRequest("preflight-job", "preflight-idempotency", cameraId);
    const submitted = await provider.submit(request);
    const status = await provider.getStatus(submitted.taskId);
    if (status.state !== "SUCCEEDED") throw new Error("fake provider did not return a successful task for " + cameraId);
    const result = await provider.getResult(submitted.taskId);
    if (result.video.kind !== "file") throw new Error("fake provider did not return packaged fixture bytes for " + cameraId);
    const bytes = readFileSync(result.video.value);
    clips.push({ cameraId, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength });
  }
  process.stdout.write(JSON.stringify(clips));
})().catch((error) => { process.stderr.write(String(error && error.message ? error.message : error)); process.exit(1); });`;
  const result = spawnSync(process.execPath, ["-e", script, fixtureDirectory], {
    cwd: functionsRoot, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Packaged fake provider cannot serve the runtime fixtures: ${(result.stderr || result.error?.message || "unknown failure").trim()}`);
  }
  return JSON.parse(result.stdout) as Array<{ cameraId: string; sha256: string; sizeBytes: number }>;
}

export async function runPreflight(): Promise<Record<string, unknown>> {
  const target = argument("target");
  if (target !== "cloud" && target !== "emulator") {
    throw new Error("Preflight requires --target=cloud or --target=emulator; the deployment target is never inferred.");
  }
  const functionsRoot = resolve(argument("functions-root") ?? process.cwd());
  const configRoot = resolve(argument("config-root") ?? join(functionsRoot, ".."));
  const projectId = argument("project") ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new Error("An explicit Firebase project ID is required via --project or GCLOUD_PROJECT.");
  }
  if (target === "cloud" && projectId.startsWith("demo-")) {
    throw new Error(`Demo project ${projectId} cannot be a cloud deployment target; use --target=emulator.`);
  }
  const config = await readEnvironmentFiles(functionsRoot, projectId);
  const bucket = argument("bucket") ?? process.env.STORAGE_BUCKET ?? config.STORAGE_BUCKET;
  if (!bucket) throw new Error("An explicit bucket is required via --bucket or STORAGE_BUCKET; the Admin SDK default bucket is never assumed.");
  if (bucket.startsWith("gs://") || /\s/.test(bucket)) throw new Error(`Bucket must be a bare bucket name (found ${bucket}).`);
  if (argument("bucket") && config.STORAGE_BUCKET && argument("bucket") !== config.STORAGE_BUCKET) {
    throw new Error("--bucket disagrees with STORAGE_BUCKET in the selected Functions environment file.");
  }
  const firestoreEmulator = process.env.FIRESTORE_EMULATOR_HOST ?? config.FIRESTORE_EMULATOR_HOST;
  const storageEmulator = process.env.STORAGE_EMULATOR_HOST ?? config.STORAGE_EMULATOR_HOST;
  if (Boolean(firestoreEmulator) !== Boolean(storageEmulator)) {
    throw new Error("Refusing a partial emulator target: FIRESTORE_EMULATOR_HOST and STORAGE_EMULATOR_HOST must be set together or not at all.");
  }
  if (target === "emulator" && (!firestoreEmulator || !storageEmulator)) {
    throw new Error("Emulator preflight requires both FIRESTORE_EMULATOR_HOST and STORAGE_EMULATOR_HOST.");
  }
  if (target === "cloud" && (firestoreEmulator || storageEmulator)) {
    throw new Error("Cloud preflight refuses emulator hosts; unset FIRESTORE_EMULATOR_HOST and STORAGE_EMULATOR_HOST.");
  }
  const provider = (process.env.VIDEO_GENERATION_PROVIDER ?? config.VIDEO_GENERATION_PROVIDER ?? "").trim().toLowerCase();
  if (provider !== "fake") {
    throw new Error("Preflight requires an explicit VIDEO_GENERATION_PROVIDER=fake; live generation stays owner-gated.");
  }
  const generationEnabled = (process.env.GENERATION_ENABLED ?? config.GENERATION_ENABLED ?? "").trim().toLowerCase() === "true";
  if (target === "cloud" && generationEnabled) {
    throw new Error("Cloud preflight refuses GENERATION_ENABLED=true without an explicit owner-approved generation batch; unset it for deploy checks.");
  }

  const failures: string[] = [];
  const record = (work: () => void): void => {
    try { work(); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  };
  const recordAsync = async (work: () => Promise<void>): Promise<void> => {
    try { await work(); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  };

  const packageJsonPath = join(functionsRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { main?: string; engines?: { node?: string } };
  const mainEntry = packageJson.main;
  record(() => {
    if (packageJson.engines?.node !== "22") throw new Error("Functions package must target Node.js 22 to match backend/firebase.json runtime nodejs22.");
  });
  record(() => {
    if (!mainEntry) throw new Error("package.json has no compiled entry point (main); run npm run build first.");
    if (!existsSync(resolve(functionsRoot, mainEntry))) throw new Error(`Compiled Functions entry point is missing: ${mainEntry}; run npm run build first.`);
  });

  let runtime: RuntimeManifest | undefined;
  await recordAsync(async () => {
    const runtimeManifestPath = join(functionsRoot, "runtime", "runtime-manifest.json");
    if (!existsSync(runtimeManifestPath)) throw new Error("Prepared runtime manifest is missing; run npm run runtime:prepare on Linux x64.");
    runtime = JSON.parse(await readFile(runtimeManifestPath, "utf8")) as RuntimeManifest;
    if (runtime.target !== "linux-x64") throw new Error(`Prepared runtime target must be linux-x64 (found ${String(runtime.target)}).`);
    if (runtime.smokeTested !== true) throw new Error("Prepared FFmpeg/ffprobe artifact has no successful normalization smoke test.");
  });

  const runtimeRoot = join(functionsRoot, "runtime");
  if (runtime) {
    for (const relativePath of ["bin/ffmpeg", "bin/ffprobe"]) {
      record(() => {
        const path = join(runtimeRoot, relativePath);
        if (!existsSync(path)) throw new Error(`Prepared runtime binary is missing: runtime/${relativePath}.`);
        const bytes = readFileSync(path);
        if (bytes.byteLength < 1024 * 1024) throw new Error(`Prepared runtime binary is unexpectedly small (${bytes.byteLength} bytes): runtime/${relativePath}.`);
        if (!isLinuxX64Elf(bytes)) throw new Error(`Prepared runtime binary is not a Linux x86_64 ELF executable: runtime/${relativePath}.`);
      });
    }
    record(() => {
      if (runtime!.binaries?.ffmpegPath !== "runtime/bin/ffmpeg" || runtime!.binaries?.ffprobePath !== "runtime/bin/ffprobe") {
        throw new Error("Runtime artifact paths disagree with the FFmpeg/ffprobe paths read by src/normalize.ts (runtime/bin/ffmpeg, runtime/bin/ffprobe).");
      }
      const ffmpegPath = process.env.FFMPEG_PATH ?? config.FFMPEG_PATH;
      const ffprobePath = process.env.FFPROBE_PATH ?? config.FFPROBE_PATH;
      if (!ffmpegPath?.endsWith("runtime/bin/ffmpeg") || !ffprobePath?.endsWith("runtime/bin/ffprobe")) {
        throw new Error("Explicit FFMPEG_PATH and FFPROBE_PATH must point at the prepared runtime/bin executables.");
      }
    });
    record(() => {
      const profile = runtime!.normalization;
      for (const [key, expected] of Object.entries(EXPECTED_NORMALIZATION)) {
        if ((profile as Record<string, unknown> | undefined)?.[key] !== expected) {
          throw new Error(`Prepared runtime normalization profile disagrees with src/normalize.ts on ${key} (expected ${String(expected)}).`);
        }
      }
      const normalizeSource = readFileSync(join(functionsRoot, "src", "normalize.ts"), "utf8");
      for (const marker of ["scale=854:480", "fps=24", "libx264", "yuv420p", "-t\", \"2"]) {
        if (!normalizeSource.includes(marker)) throw new Error(`src/normalize.ts no longer produces the prepared profile (missing ${marker}).`);
      }
    });
    record(() => {
      const fixtures = runtime!.fixtures;
      if (!Array.isArray(fixtures) || fixtures.length !== 4 ||
          ["CAM-01", "CAM-02", "CAM-03", "CAM-04"].some((cameraId) => !fixtures.some((fixture) => fixture.cameraId === cameraId))) {
        throw new Error("Prepared runtime must contain the four fake-provider MP4 fixtures (CAM-01..CAM-04).");
      }
      for (const fixture of fixtures) {
        const path = join(functionsRoot, fixture.path);
        if (!existsSync(path)) throw new Error(`Prepared runtime fixture is missing: ${fixture.path}.`);
        const bytes = readFileSync(path);
        if (bytes.toString("ascii", 4, 8) !== "ftyp") throw new Error(`Prepared runtime fixture is not an MP4 file: ${fixture.path}.`);
        const hash = createHash("sha256").update(bytes).digest("hex");
        if (hash !== fixture.sha256 || bytes.byteLength !== fixture.sizeBytes || fixture.durationMs !== 2000) {
          throw new Error(`Prepared runtime fixture metadata does not match its bytes: ${fixture.cameraId}.`);
        }
      }
    });
    await recordAsync(async () => {
      const fixtureDirectory = join(functionsRoot, runtime!.fixtureDirectory ?? "runtime/fixtures");
      if (runtime!.fixtureDirectory !== "runtime/fixtures") {
        throw new Error("Prepared fixture directory must be runtime/fixtures so the Functions artifact is self-contained.");
      }
      const probed = probePackagedProvider(functionsRoot, fixtureDirectory);
      for (const clip of probed) {
        const expected = runtime!.fixtures!.find((fixture) => fixture.cameraId === clip.cameraId);
        if (!expected || expected.sha256 !== clip.sha256 || expected.sizeBytes !== clip.sizeBytes) {
          throw new Error(`Packaged fake provider returned unexpected bytes for ${clip.cameraId}.`);
        }
      }
    });
  }

  const compiledMainPath = mainEntry ? resolve(functionsRoot, mainEntry) : undefined;
  if (compiledMainPath && existsSync(compiledMainPath)) {
    const compiled = readFileSync(compiledMainPath, "utf8");
    record(() => {
      const missing = REQUIRED_EXPORTS.filter((name) => !new RegExp(`exports\\.${name}\\b|${name}\\s*[:=]`).test(compiled));
      if (missing.length) throw new Error(`Compiled Functions entry point is missing required exports: ${missing.join(", ")}.`);
    });
    record(() => {
      if (!/createRuntimeServices|createGenerationServices/.test(compiled)) {
        throw new Error("Compiled Functions entry point does not connect the generation runtime factory (createRuntimeServices/createGenerationServices); the deployed task handler would fall back to PROVIDER_UNAVAILABLE.");
      }
    });
    record(() => {
      if (!/runtime\/fixtures|FAKE_FIXTURE_DIR/.test(compiled)) {
        throw new Error("Compiled Functions entry point does not pass the packaged runtime/fixtures directory to the fake provider; the repository-relative apps/tv_app/assets path does not exist after deployment.");
      }
    });
    record(() => {
      const taskStart = compiled.indexOf("onTaskDispatched");
      const options = taskStart >= 0 ? compiled.slice(taskStart, taskStart + 800) : "";
      const declared = Number(/timeoutSeconds:\s*(\d+)/.exec(options)?.[1] ?? 0);
      const workerTimeout = integerSetting("GENERATION_WORKER_TIMEOUT_SECONDS", config);
      const providerTimeout = integerSetting("PROVIDER_POLL_TIMEOUT_SECONDS", config);
      const headroom = integerSetting("NORMALIZATION_HEADROOM_SECONDS", config);
      if (workerTimeout < providerTimeout + headroom) {
        throw new Error(`GENERATION_WORKER_TIMEOUT_SECONDS=${workerTimeout} is shorter than PROVIDER_POLL_TIMEOUT_SECONDS=${providerTimeout} plus NORMALIZATION_HEADROOM_SECONDS=${headroom}.`);
      }
      if (declared === 0) {
        throw new Error("runGeneration does not declare timeoutSeconds; the Functions task deadline cannot be inferred from environment alone.");
      }
      if (declared !== workerTimeout) {
        throw new Error(`runGeneration timeoutSeconds=${declared} does not match GENERATION_WORKER_TIMEOUT_SECONDS=${workerTimeout}.`);
      }
    });
  } else {
    record(() => { throw new Error("Compiled Functions entry point is unavailable; composition checks cannot run."); });
  }

  record(() => {
    const firebaseConfigPath = join(configRoot, "firebase.json");
    if (!existsSync(firebaseConfigPath)) throw new Error(`backend/firebase.json is missing at ${firebaseConfigPath}.`);
    const firebaseConfig = JSON.parse(readFileSync(firebaseConfigPath, "utf8")) as {
      functions?: { source?: string; runtime?: string; predeploy?: string[] };
    };
    if (firebaseConfig.functions?.source !== "functions" || firebaseConfig.functions.runtime !== "nodejs22") {
      throw new Error("backend/firebase.json Functions source/runtime does not match this Node.js 22 package.");
    }
    if (!firebaseConfig.functions.predeploy?.some((hook) => hook.includes("run predeploy"))) {
      throw new Error("backend/firebase.json must run the package predeploy validation before uploading Functions.");
    }
  });

  if (failures.length) {
    const error = new Error(`${failures.length} preflight check(s) failed:\n- ${failures.join("\n- ")}`) as Error & { failures?: string[] };
    error.failures = failures;
    throw error;
  }

  const runtimeBytes = Number(runtime?.runtimeBytes ?? 0);
  const warnings: string[] = [];
  if (runtimeBytes > 100 * 1024 * 1024) {
    warnings.push(`Prepared runtime is ${(runtimeBytes / (1024 * 1024)).toFixed(1)} MiB; verify it against the current Functions source upload limit before npm run deploy.`);
  }
  return {
    preflight: "passed",
    target,
    projectId,
    bucket,
    functionsRoot,
    runtimeTarget: runtime?.target,
    fixtureDirectory: runtime?.fixtureDirectory,
    functionsEntry: mainEntry,
    workerTimeoutSeconds: integerSetting("GENERATION_WORKER_TIMEOUT_SECONDS", config),
    providerPollTimeoutSeconds: integerSetting("PROVIDER_POLL_TIMEOUT_SECONDS", config),
    normalizationHeadroomSeconds: integerSetting("NORMALIZATION_HEADROOM_SECONDS", config),
    runtimeBytes,
    warnings,
  };
}

if (require.main === module) {
  runPreflight()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
