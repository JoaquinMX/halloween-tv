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
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Storage } from "@google-cloud/storage";
import {
  EXPECTED_NORMALIZATION,
  EXPECTED_SCENARIO_COUNT,
  PACKAGED_SCENARIO_DIR,
  SCENARIO_CATALOG_FILENAME,
  SCENARIO_CATALOG_VERSION,
  SCENARIO_REF_FILENAMES,
  SITUATIONS_CATALOG_VERSION,
  SITUATIONS_FILENAME,
  assertLinuxX64Executable,
  assertMp4Container,
  assertSafePackagedPath,
  readRuntimeManifest,
  sha256Hex,
  validateFixtureBytes,
  validateScenarioInventory,
  validateScenarioReferenceBytes,
  type RuntimeManifest,
} from "./runtime_artifact";

const REQUIRED_EXPORTS = ["requestGeneration", "runGeneration", "getCurrentManifest", "getDeliveryUrls", "acknowledgeDelivery", "sweepExpiredMedia"];
const CONFIG_KEYS = new Set([
  "STORAGE_BUCKET", "FFMPEG_PATH", "FFPROBE_PATH", "GENERATION_WORKER_TIMEOUT_SECONDS",
  "PROVIDER_POLL_TIMEOUT_SECONDS", "NORMALIZATION_HEADROOM_SECONDS", "VIDEO_GENERATION_PROVIDER",
  "FIRESTORE_EMULATOR_HOST", "STORAGE_EMULATOR_HOST", "FAKE_FIXTURE_DIR",
  "GENERATION_ENABLED", "PROVIDER_POLL_INTERVAL_MS", "PROVIDER_TIMEOUT_MS",
]);

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

/** GCS returns e.g. "US-EAST1"; trigger regions are lowercase "us-east1". */
function normalizeRegionName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Reads the pinned v2 storage-trigger region from the artifact under check
 * (compiled lib first, TypeScript source as fallback). The trigger must name
 * its region explicitly because it defaults to the functions region otherwise.
 */
function resolveStorageTriggerRegion(functionsRoot: string): string {
  for (const candidate of [join(functionsRoot, "lib", "src", "config.js"), join(functionsRoot, "src", "config.ts")]) {
    if (!existsSync(candidate)) continue;
    const match = /STORAGE_TRIGGER_REGION\s*=\s*["']([^"']+)["']/.exec(readFileSync(candidate, "utf8"));
    if (match) return match[1];
  }
  throw new Error("Storage trigger region is not configured (STORAGE_TRIGGER_REGION missing in lib/src/config.js and src/config.ts); pin onGuestIngestFinalized to the ingest bucket region.");
}

/**
 * Resolves the deploy bucket's location read-only. PREFLIGHT_BUCKET_LOCATION
 * (or --bucket-location) is an offline/test seam; otherwise the location is
 * read from the live bucket via ADC and never written.
 */
async function resolveBucketLocation(bucket: string): Promise<string> {
  const override = (argument("bucket-location") ?? process.env.PREFLIGHT_BUCKET_LOCATION ?? "").trim();
  if (override) return override;
  try {
    const [metadata] = await new Storage().bucket(bucket).getMetadata();
    const location = String((metadata as { location?: unknown }).location ?? "");
    if (!location) throw new Error("the Storage API returned an empty location");
    return location;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not resolve location for bucket ${bucket}: ${detail}. Provide --bucket-location or PREFLIGHT_BUCKET_LOCATION for offline checks.`);
  }
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

/** Minimum runGeneration worker memory for ffmpeg normalization headroom. */
const WORKER_MEMORY_FLOOR_MIB = 512;

function parseMemoryToMiB(raw: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(MiB|GiB)\s*$/i.exec(raw);
  if (!match) {
    throw new Error(`runGeneration memory=${JSON.stringify(raw)} is not a recognized Functions memory size (expected e.g. "512MiB" or "1GiB").`);
  }
  const value = Number(match[1]);
  return match[2].toLowerCase() === "gib" ? value * 1024 : value;
}

/**
 * Resolves the runGeneration worker memory from the compiled artifact. The
 * production entry point declares it via the GENERATION_WORKER_MEMORY named
 * constant (src/config.ts), so the compiled index.js references the constant
 * rather than a literal; fall back to the compiled config module to read it.
 */
function resolveWorkerMemory(compiled: string, taskOptions: string, functionsRoot: string): { raw: string; mib: number } {
  const literal = /memory:\s*["']([^"']+)["']/.exec(taskOptions)?.[1];
  if (literal) return { raw: literal, mib: parseMemoryToMiB(literal) };
  // Named-constant binding (memory: <scope>.GENERATION_WORKER_MEMORY). The
  // pattern requires the memory: key so code comments that merely mention the
  // constant name never satisfy the check when the declaration is stripped.
  if (/memory\s*:\s*[^"'`{}\n]*GENERATION_WORKER_MEMORY/.test(taskOptions)) {
    for (const candidate of [join(functionsRoot, "lib", "src", "config.js"), join(functionsRoot, "lib", "config.js")]) {
      if (!existsSync(candidate)) continue;
      const configured = /GENERATION_WORKER_MEMORY\s*=\s*["']([^"']+)["']/.exec(readFileSync(candidate, "utf8"))?.[1];
      if (configured) return { raw: configured, mib: parseMemoryToMiB(configured) };
    }
  }
  throw new Error("runGeneration does not declare memory; the task worker needs explicit memory headroom for ffmpeg normalization (GENERATION_WORKER_MEMORY, at least 512MiB).");
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
  const generationEnabled = (process.env.GENERATION_ENABLED ?? config.GENERATION_ENABLED ?? "").trim().toLowerCase() === "true";
  const allowGeneration = process.argv.includes("--allow-generation");
  const liveBatchRequested = process.argv.some((item) => item === "--allow-live-batch" || item.startsWith("--allow-live-batch="));
  const liveBatchApprovalRef = argument("allow-live-batch")?.trim();
  if (liveBatchRequested && !liveBatchApprovalRef) {
    throw new Error("--allow-live-batch requires an explicit owner approval reference via --allow-live-batch=<approval-ref>; no reference = no live batch.");
  }
  if (liveBatchApprovalRef && target !== "cloud") {
    throw new Error("--allow-live-batch is a cloud-only explicit opt-in; emulator targets never enable generation.");
  }
  if (liveBatchApprovalRef && allowGeneration) {
    throw new Error("--allow-live-batch cannot be combined with --allow-generation; use exactly one explicit opt-in.");
  }
  if (liveBatchApprovalRef) {
    if (!generationEnabled) {
      throw new Error(`--allow-live-batch=${liveBatchApprovalRef} requires GENERATION_ENABLED=true for the approved batch window; otherwise unset it for deploy checks.`);
    }
    if (provider !== "alibaba") {
      throw new Error(`--allow-live-batch=${liveBatchApprovalRef} requires VIDEO_GENERATION_PROVIDER=alibaba; live generation stays owner-gated.`);
    }
  } else {
    if (provider !== "fake") {
      throw new Error("Preflight requires an explicit VIDEO_GENERATION_PROVIDER=fake; live generation stays owner-gated.");
    }
    if (target === "cloud" && generationEnabled && !allowGeneration) {
      throw new Error("Cloud preflight refuses GENERATION_ENABLED=true without an explicit owner-approved generation batch; unset it for deploy checks.");
    }
    if (allowGeneration && target !== "cloud") {
      throw new Error("--allow-generation is a cloud-only explicit opt-in; emulator targets never enable generation.");
    }
    if (allowGeneration && provider !== "fake") {
      throw new Error("--allow-generation permits only the fake provider; live generation stays owner-gated.");
    }
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
    runtime = readRuntimeManifest(runtimeManifestPath);
    if (runtime.target !== "linux-x64") throw new Error(`Prepared runtime target must be linux-x64 (found ${String(runtime.target)}).`);
    if (runtime.smokeTested === true) {
      if (runtime.validationMode !== "executed") {
        throw new Error("Prepared runtime claims smokeTested=true without executed validation; smokeTested requires binary execution.");
      }
    } else if (runtime.validationMode !== "structural-only") {
      throw new Error("Prepared FFmpeg/ffprobe artifact has no successful normalization smoke test and no structural-only record.");
    }
  });

  const runtimeRoot = join(functionsRoot, "runtime");
  if (runtime) {
    for (const relativePath of ["bin/ffmpeg", "bin/ffprobe"]) {
      record(() => {
        // Structural read-only check: the Linux binaries are never executed here.
        assertLinuxX64Executable(join(runtimeRoot, relativePath), `Prepared runtime ${relativePath}`);
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
        assertMp4Container(bytes, `Prepared runtime fixture: ${fixture.path}`);
        validateFixtureBytes(bytes, fixture);
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

    // Cartoon scenario inventory: both versioned catalogs plus all 16
    // reference stills ship inside the artifact and hash-match their records.
    record(() => {
      const scenarios = runtime!.scenarios;
      if (!scenarios) throw new Error("Prepared runtime is missing the scenarios section; run npm run runtime:prepare.");
      if (scenarios.catalogVersion !== SCENARIO_CATALOG_VERSION) {
        throw new Error(`Prepared scenario catalog version must be ${SCENARIO_CATALOG_VERSION} (found ${String(scenarios.catalogVersion)}).`);
      }
      if (scenarios.situationsVersion !== SITUATIONS_CATALOG_VERSION) {
        throw new Error(`Prepared situations version must be ${SITUATIONS_CATALOG_VERSION} (found ${String(scenarios.situationsVersion)}).`);
      }
      if (scenarios.catalogPath !== `${PACKAGED_SCENARIO_DIR}/${SCENARIO_CATALOG_FILENAME}` ||
          scenarios.situationsPath !== `${PACKAGED_SCENARIO_DIR}/${SITUATIONS_FILENAME}`) {
        throw new Error("Prepared scenario catalog paths must live under runtime/scenarios so the artifact is self-contained.");
      }
      const records = scenarios.records;
      if (!Array.isArray(records) || records.length !== EXPECTED_SCENARIO_COUNT) {
        throw new Error(`Prepared runtime must contain exactly ${EXPECTED_SCENARIO_COUNT} scenario records.`);
      }
      const seenFilenames = new Set<string>();
      for (const record of records) {
        assertSafePackagedPath(record.referencePath, `Scenario ${record.id} referencePath`);
        if (seenFilenames.has(record.sourceFilename)) throw new Error(`Duplicate prepared scenario file: ${record.sourceFilename}.`);
        seenFilenames.add(record.sourceFilename);
        const packaged = join(functionsRoot, PACKAGED_SCENARIO_DIR, "scenario_refs", record.sourceFilename);
        if (!existsSync(packaged)) throw new Error(`Prepared scenario reference is missing: ${packaged}.`);
        validateScenarioReferenceBytes(readFileSync(packaged), record);
      }
      for (const name of SCENARIO_REF_FILENAMES) {
        if (!seenFilenames.has(name)) throw new Error(`Prepared runtime is missing allowlisted scenario file: ${name}.`);
      }
    });
    record(() => {
      // Catalog JSONs are verified structurally against the same inventory
      // contract the packager used; structural form + byte digests together
      // prove the artifact matches the reviewed catalogs.
      const readJson = (relativePath: string, label: string): unknown => {
        assertSafePackagedPath(relativePath, label);
        const absolute = join(functionsRoot, relativePath);
        if (!existsSync(absolute)) throw new Error(`${label} is missing: ${relativePath}.`);
        try {
          return JSON.parse(readFileSync(absolute, "utf8")) as unknown;
        } catch {
          throw new Error(`${label} at ${relativePath} is not valid JSON.`);
        }
      };
      const scenarios = runtime!.scenarios;
      if (!scenarios) throw new Error("Prepared runtime is missing the scenarios section; run npm run runtime:prepare.");
      const catalog = readJson(scenarios.catalogPath ?? "", "Scenario catalog");
      const situations = readJson(scenarios.situationsPath ?? "", "Situations catalog");
      const inventoried = validateScenarioInventory(catalog, situations);
      for (const record of inventoried) {
        const pinned = scenarios.records?.find((entry) => entry.id === record.id);
        if (!pinned || pinned.sha256 !== record.sha256 || pinned.sizeBytes !== record.sizeBytes) {
          throw new Error(`Scenario ${record.id} catalog digest disagrees with the prepared runtime manifest.`);
        }
      }
      // Owner-reviewable sample batch: every sample resolves to known ids and
      // the pair is explicitly compatible, so p2 can stage it without edits.
      const samples = (catalog as { reviewBatch?: { samples?: Array<{ scenarioId?: string; situationId?: string }> } }).reviewBatch?.samples;
      if (!Array.isArray(samples) || samples.length === 0) {
        throw new Error("Scenario catalog reviewBatch must list at least one owner-reviewable sample.");
      }
      const events = (situations as { events?: Array<{ id?: string; compatibleScenarios?: string[] }> }).events ?? [];
      for (const sample of samples) {
        const scenario = inventoried.find((entry) => entry.id === sample.scenarioId);
        const event = events.find((entry) => entry.id === sample.situationId);
        if (!scenario) throw new Error(`Review batch references unknown scenario: ${String(sample.scenarioId)}.`);
        if (!event) throw new Error(`Review batch references unknown situation: ${String(sample.situationId)}.`);
        if (!event.compatibleScenarios?.includes(scenario.id)) {
          throw new Error(`Review batch pairs incompatible scenario/situation: ${scenario.id} + ${String(sample.situationId)}.`);
        }
      }
    });
    record(() => {
      // Relocated-artifact loader: the compiled scenario catalog module must
      // ship so entries resolve from runtime/scenarios without the repo root.
      const compiledCatalog = join(functionsRoot, "lib", "src", "scenario_catalog.js");
      if (!existsSync(compiledCatalog)) {
        throw new Error("Compiled scenario catalog is missing (lib/src/scenario_catalog.js); run npm run build first.");
      }
      const source = readFileSync(compiledCatalog, "utf8");
      if (!source.includes("runtime/scenarios")) {
        throw new Error("Compiled scenario catalog does not resolve the packaged runtime/scenarios copy; relocated artifacts would need the repo checkout.");
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
      const options = taskStart >= 0 ? compiled.slice(taskStart, taskStart + 1600) : "";
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
      const workerMemory = resolveWorkerMemory(compiled, options, functionsRoot);
      if (workerMemory.mib < WORKER_MEMORY_FLOOR_MIB) {
        throw new Error(`runGeneration memory=${workerMemory.raw} is below the ${WORKER_MEMORY_FLOOR_MIB}MiB floor required for ffmpeg normalization headroom; raise GENERATION_WORKER_MEMORY to at least 512MiB (1GiB configured).`);
      }
    });
  } else {
    record(() => { throw new Error("Compiled Functions entry point is unavailable; composition checks cannot run."); });
  }

  record(() => {
    const firebaseConfigPath = join(configRoot, "firebase.json");
    if (!existsSync(firebaseConfigPath)) throw new Error(`backend/firebase.json is missing at ${firebaseConfigPath}.`);
    const firebaseConfig = JSON.parse(readFileSync(firebaseConfigPath, "utf8")) as {
      functions?: { source?: string; runtime?: string; predeploy?: string[]; ignore?: string[] };
    };
    if (firebaseConfig.functions?.source !== "functions" || firebaseConfig.functions.runtime !== "nodejs22") {
      throw new Error("backend/firebase.json Functions source/runtime does not match this Node.js 22 package.");
    }
    if (!firebaseConfig.functions.predeploy?.some((hook) => hook.includes("run predeploy"))) {
      throw new Error("backend/firebase.json must run the package predeploy validation before uploading Functions.");
    }
    // Packaging guard: the scenario refs + catalog JSONs (assets/ and the
    // prepared runtime/scenarios copy) must ship in the Functions artifact.
    // Any ignore rule matching those trees breaks the relocated artifact.
    // (The cartoons_scenarios_reference owner-checkout name is ignored by
    // construction so a duplicate source directory can never deploy.)
    for (const pattern of firebaseConfig.functions.ignore ?? []) {
      const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
      const hitsTree = (tree: string): boolean =>
        normalized === tree || normalized.startsWith(`${tree}/`) ||
        normalized === `${tree}/**` || normalized === "**" || normalized === "*.json";
      if (hitsTree("assets") || hitsTree("runtime")) {
        throw new Error(`backend/firebase.json ignore pattern ${JSON.stringify(pattern)} would exclude packaged scenario catalog assets.`);
      }
    }
  });

  if (target === "cloud") {
    await recordAsync(async () => {
      const triggerRegion = resolveStorageTriggerRegion(functionsRoot);
      const bucketLocation = await resolveBucketLocation(bucket);
      if (normalizeRegionName(triggerRegion) !== normalizeRegionName(bucketLocation)) {
        throw new Error(`Storage trigger region ${triggerRegion} does not match deploy bucket ${bucket} location ${bucketLocation}; v2 storage triggers must live in the bucket's region.`);
      }
      if (compiledMainPath && existsSync(compiledMainPath)) {
        const compiled = readFileSync(compiledMainPath, "utf8");
        if (/onObjectFinalized/.test(compiled) &&
            !compiled.includes("STORAGE_TRIGGER_REGION") && !compiled.includes(triggerRegion)) {
          throw new Error(`Compiled storage trigger does not pin region ${triggerRegion}; pass region: STORAGE_TRIGGER_REGION to onObjectFinalized.`);
        }
      }
    });
  }

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
  if (runtime?.validationMode === "structural-only") {
    warnings.push(
      "Runtime artifact is structural-only: the packaged Linux binaries were hashed and header-checked but never executed on this host; " +
      "the normalization smoke test runs on linux-x64 execution before live use.",
    );
  }
  if (allowGeneration) {
    warnings.push("Explicit fake-only rehearsal opt-in (--allow-generation with VIDEO_GENERATION_PROVIDER=fake); restore GENERATION_ENABLED=unset/false after the rehearsal window.");
  }
  if (liveBatchApprovalRef) {
    warnings.push(
      `Owner-approved live batch ${liveBatchApprovalRef} with VIDEO_GENERATION_PROVIDER=alibaba; ` +
      "mandatory restore after the batch: GENERATION_ENABLED unset/false + VIDEO_GENERATION_PROVIDER=fake + redeploy.",
    );
  }
  let workerMemory: { raw: string; mib: number } | undefined;
  try {
    if (compiledMainPath && existsSync(compiledMainPath)) {
      const compiledText = readFileSync(compiledMainPath, "utf8");
      const taskStart = compiledText.indexOf("onTaskDispatched");
      workerMemory = resolveWorkerMemory(compiledText, taskStart >= 0 ? compiledText.slice(taskStart, taskStart + 1600) : "", functionsRoot);
    }
  } catch {
    workerMemory = undefined;
  }
  return {
    preflight: "passed",
    target,
    projectId,
    bucket,
    functionsRoot,
    runtimeTarget: runtime?.target,
    runtimeValidationMode: runtime?.validationMode ?? "unknown",
    runtimeSmokeTested: runtime?.smokeTested === true,
    binarySha256: {
      ffmpeg: runtime?.binaries?.ffmpegSha256,
      ffprobe: runtime?.binaries?.ffprobeSha256,
    },
    fixtureDirectory: runtime?.fixtureDirectory,
    scenarioCatalogVersion: runtime?.scenarios?.catalogVersion,
    situationsVersion: runtime?.scenarios?.situationsVersion,
    scenarioCount: runtime?.scenarios?.count,
    budgetGate: {
      providerSpendAuthorized: "0 (none) for catalog preparation and verification",
      generationOptIn: liveBatchApprovalRef ? "live-batch" : (allowGeneration ? "fake-only-rehearsal" : "disabled"),
      note: "No live provider calls, cloud migrations, or deploys run in this check; --allow-live-batch=<owner-approval-ref> stays the only live opt-in.",
    },
    functionsEntry: mainEntry,
    generationOptIn: liveBatchApprovalRef ? "live-batch" : (allowGeneration ? "fake-only-rehearsal" : "disabled"),
    liveBatch: Boolean(liveBatchApprovalRef),
    liveBatchApprovalRef: liveBatchApprovalRef ?? null,
    approvalRef: liveBatchApprovalRef ?? null,
    workerTimeoutSeconds: integerSetting("GENERATION_WORKER_TIMEOUT_SECONDS", config),
    providerPollTimeoutSeconds: integerSetting("PROVIDER_POLL_TIMEOUT_SECONDS", config),
    normalizationHeadroomSeconds: integerSetting("NORMALIZATION_HEADROOM_SECONDS", config),
    workerMemory: workerMemory?.raw,
    workerMemoryMiB: workerMemory?.mib,
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
