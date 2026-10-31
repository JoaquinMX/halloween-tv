/**
 * Shared cross-host validation for the Linux x64 Functions runtime artifact.
 *
 * Both `prepare_runtime.ts` (packaging) and `deploy_preflight.ts` (gate) use
 * these helpers so the artifact contract is defined once:
 *
 *   runtime/bin/ffmpeg + runtime/bin/ffprobe  (pinned Linux x64 ELF binaries)
 *   runtime/fixtures/cam01..cam04.mp4          (playable fixture bytes)
 *   runtime/fixtures/fixture_manifest.json     (byte-identical repo copy)
 *   runtime/runtime-manifest.json              (hashes, profile, validation mode)
 *
 * Validation modes:
 *   "executed"        — packaged binaries were executed on linux-x64
 *                       (capability + normalization smoke checks passed).
 *   "structural-only" — darwin/arm64 (or other non-target) host: binaries are
 *                       validated structurally (package version, ELF64 LE
 *                       x86-64 header, size, exec bits, hashes) and NEVER
 *                       executed. smokeTested is always false in this mode.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

export const RUNTIME_TARGET = "linux-x64";

export const PINNED_PACKAGES = {
  ffmpeg: { packageName: "@ffmpeg-installer/linux-x64", binary: "ffmpeg", expectedVersion: "4.1.0" },
  ffprobe: { packageName: "@ffprobe-installer/linux-x64", binary: "ffprobe", expectedVersion: "5.2.0" },
} as const;

export type PinnedEntry = (typeof PINNED_PACKAGES)[keyof typeof PINNED_PACKAGES];

/** Fixed delivery normalization profile produced by src/normalize.ts. */
export const EXPECTED_NORMALIZATION = {
  codec: "h264",
  pixelFormat: "yuv420p",
  frameRate: "24/1",
  width: 854,
  height: 480,
  durationMs: 2000,
} as const;

/** Repository fixture profile (pre-normalization offline MP4s). */
export const FIXTURE_PROFILE = {
  codec: "h264",
  pixelFormat: "yuv420p",
  frameRate: "24/1",
  width: 960,
  height: 540,
  durationMs: 2000,
} as const;

export const REQUIRED_FIXTURE_CAMERAS = ["CAM-01", "CAM-02", "CAM-03", "CAM-04"] as const;

export const REQUIRED_FFMPEG_FILTERS = ["fps", "scale", "pad", "setsar", "tpad"] as const;

export const MIN_BINARY_BYTES = 1024 * 1024;

export type ValidationMode = "executed" | "structural-only";

export interface RuntimeManifest {
  target?: string;
  preparedBy?: string;
  validationMode?: ValidationMode;
  smokeTested?: boolean;
  structuralOnly?: boolean;
  hostPlatform?: string;
  hostArch?: string;
  binaries?: {
    ffmpegPath?: string;
    ffprobePath?: string;
    ffmpegVersion?: string;
    ffprobeVersion?: string;
    ffmpegBytes?: number;
    ffprobeBytes?: number;
    ffmpegSha256?: string;
    ffprobeSha256?: string;
  };
  fixtureDirectory?: string;
  licenses?: unknown;
  fixtures?: Array<{ cameraId: string; path: string; sha256: string; sizeBytes: number; durationMs: number }>;
  normalization?: typeof EXPECTED_NORMALIZATION;
  runtimeBytes?: number;
  scenarios?: {
    catalogVersion?: string;
    situationsVersion?: string;
    catalogPath?: string;
    situationsPath?: string;
    refDirectory?: string;
    count?: number;
    records?: Array<{ id: string; sourceFilename: string; referencePath: string; sha256: string; sizeBytes: number }>;
  };
}

export function fail(message: string): never {
  throw new Error(message);
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** True when the bytes are a little-endian 64-bit x86-64 ELF executable. */
export function isLinuxX64Elf(bytes: Buffer): boolean {
  if (bytes.length < 20) return false;
  return (
    bytes[0] === 0x7f &&
    bytes.toString("ascii", 1, 4) === "ELF" &&
    bytes[4] === 2 &&
    bytes[5] === 1 &&
    bytes.readUInt16LE(18) === 62
  );
}

export function describeElf(bytes: Buffer): string {
  if (bytes.length < 20) return `too short (${bytes.length} bytes)`;
  const magic = bytes.subarray(0, 4).toString("hex");
  return `magic=0x${magic} class=${bytes[4]} data=${bytes[5]} machine=${bytes.readUInt16LE(18)}`;
}

/** Structural ELF assertion: reads bytes, never executes. */
export function assertLinuxX64Executable(path: string, label: string): Buffer {
  if (!existsSync(path)) fail(`${label} binary is missing at ${path}.`);
  const bytes = readFileSync(path);
  if (bytes.byteLength < MIN_BINARY_BYTES) {
    fail(`${label} at ${path} is unexpectedly small (${bytes.byteLength} bytes).`);
  }
  if (!isLinuxX64Elf(bytes)) {
    fail(
      `${label} at ${path} is not a little-endian Linux x86_64 ELF executable ` +
        `(target ${RUNTIME_TARGET}; found ${describeElf(bytes)}).`,
    );
  }
  return bytes;
}

/** Exec-bit assertion: the packaged binaries must stay executable after copy. */
export function assertExecutableMode(path: string, label: string): void {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o111) === 0) {
    fail(`${label} at ${path} is not executable (mode ${mode.toString(8)}).`);
  }
}

/** MP4 container check via the `ftyp` box at offset 4. */
export function assertMp4Container(bytes: Buffer, label: string): void {
  if (bytes.toString("ascii", 4, 8) !== "ftyp") {
    fail(`${label} is not an MP4 file (missing ftyp box).`);
  }
}

export interface FixtureExpectation {
  cameraId: string;
  sha256: string;
  sizeBytes: number;
  durationMs: number;
}

/** Byte-level fixture validation: hash + size + MP4 container. Never executes. */
export function validateFixtureBytes(bytes: Buffer, expected: FixtureExpectation): void {
  if (!/^[a-f0-9]{64}$/.test(expected.sha256)) fail(`Fixture manifest metadata is invalid for ${expected.cameraId}.`);
  if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes <= 0) {
    fail(`Fixture manifest metadata is invalid for ${expected.cameraId}.`);
  }
  if (expected.durationMs !== 2000) fail(`Fixture manifest metadata is invalid for ${expected.cameraId}.`);
  assertMp4Container(bytes, `Prepared runtime fixture for ${expected.cameraId}`);
  const digest = sha256Hex(bytes);
  if (bytes.byteLength !== expected.sizeBytes || digest !== expected.sha256) {
    fail(
      `Prepared runtime fixture metadata does not match its bytes for ${expected.cameraId} ` +
        `(size ${bytes.byteLength} vs ${expected.sizeBytes}, sha256 ${digest.slice(0, 12)}… vs ${expected.sha256.slice(0, 12)}…).`,
    );
  }
}

export function readRuntimeManifest(path: string): RuntimeManifest {
  if (!existsSync(path)) fail(`Prepared runtime manifest is missing: ${path}; run npm run runtime:prepare first.`);
  return JSON.parse(readFileSync(path, "utf8")) as RuntimeManifest;
}

/** Resolves the pinned installer package version without executing its binary. */
export function installedPackageVersion(entry: { packageName: string; binary: string; expectedVersion: string }, fromDirectory: string): { directory: string; version: string } {
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve(`${entry.packageName}/package.json`, { paths: [fromDirectory] });
  } catch {
    fail(
      `Pinned package ${entry.packageName} is not installed; run npm install in backend/functions ` +
        `with Linux x64 packages included (npm install --force on darwin hosts).`,
    );
  }
  const { dirname } = require("node:path") as typeof import("node:path");
  const directory = dirname(packageJsonPath);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
  if (packageJson.version !== entry.expectedVersion) {
    fail(`${entry.packageName} resolved to version ${String(packageJson.version)} but ${entry.expectedVersion} is pinned.`);
  }
  return { directory, version: entry.expectedVersion };
}

// ---------------------------------------------------------------------------
// Cartoon scenario catalog inventory (cycle-13 p1). Both catalog JSONs plus
// all 16 reference stills ship inside the Functions artifact and are verified
// by hash at packaging (prepare_runtime) and at the gate (deploy_preflight).
// ---------------------------------------------------------------------------

/** Versioned catalog files served from the functions root. */
export const SCENARIO_CATALOG_VERSION = "v1";
export const SITUATIONS_CATALOG_VERSION = "v1";
export const SCENARIO_CATALOG_FILENAME = `scenario_catalog.${SCENARIO_CATALOG_VERSION}.json`;
export const SITUATIONS_FILENAME = `situations.${SITUATIONS_CATALOG_VERSION}.json`;

/** Exactly one record per allowlisted reference file. */
export const EXPECTED_SCENARIO_COUNT = 16;

/** Allowlisted reference stills (exact filenames under assets/scenario_refs/). */
export const SCENARIO_REF_FILENAMES = [
  "2938c25f-4772-415d-bab0-941b2521be3d.JPG",
  "3f2db6e1-7b6b-4bb9-992d-a1f3584fbad0.JPG",
  "52398ea0-a1f8-4639-aa74-1671ce6c276b.JPG",
  "5c0e9bf8-864a-4146-b2f7-4e04f5c2520e.JPG",
  "78b5c629-0ce2-4944-9ce1-7eb9b8570ddf.JPG",
  "7a712bff-0095-4610-9741-f9a380bce068.JPG",
  "96cf7a63-7d8e-485e-a7cc-9e6654b920e6.JPG",
  "98a6182f-1de7-46a4-8013-f7e501e85d21.JPG",
  "9b8b9749-da46-4782-b34f-72137f9f5f00.JPG",
  "IMG_3924.JPG",
  "a840217b-d807-4e2f-9476-370443e83bbc.JPG",
  "bd75cef5-bd11-4fb9-8ac7-89498a765f93.JPG",
  "cb10e539-fec1-4416-8717-50a427e46dda.JPG",
  "d317360a-7db0-4a19-a778-c1e35c46aa18.JPG",
  "f92785a5-c171-40e8-846d-76ba366446f1.JPG",
  "ff03626f-fe41-40b0-9d12-92ba6a9aaa5a.JPG",
] as const;

export const SCENARIO_REF_DIR = "assets/scenario_refs";
export const PACKAGED_SCENARIO_DIR = "runtime/scenarios";
export const PACKAGED_SCENARIO_REF_DIR = "runtime/scenarios/scenario_refs";

export interface ScenarioManifestRecord {
  id: string;
  sourceFilename: string;
  referencePath: string;
  sha256: string;
  sizeBytes: number;
}

export interface ScenarioManifestSection {
  catalogVersion: string;
  situationsVersion: string;
  catalogPath: string;
  situationsPath: string;
  refDirectory: string;
  count: number;
  records: ScenarioManifestRecord[];
}

/** Portable-path gate: rejects absolute, home, drive, traversal, and dot segments. */
export function assertSafePackagedPath(path: string, label: string): void {
  if (typeof path !== "string" || !path) fail(`${label} must be a non-empty repo-relative path.`);
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path) || path.includes("\\")) {
    fail(`${label} must be a portable repo-relative path (found ${JSON.stringify(path)}).`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`${label} escapes or misroutes the artifact (found ${JSON.stringify(path)}).`);
  }
  for (const needle of ["/tmp/", "/Users/", "~"]) {
    if (path.includes(needle)) fail(`${label} leaks a host path (found ${JSON.stringify(path)}).`);
  }
}

/** Structural scenario-inventory check over a parsed catalog object (no fs). */
export function validateScenarioInventory(catalog: unknown, situations: unknown): ScenarioManifestRecord[] {
  const records = (catalog as { records?: unknown }).records;
  if (!Array.isArray(records) || records.length !== EXPECTED_SCENARIO_COUNT) {
    fail(`Scenario catalog must hold exactly ${EXPECTED_SCENARIO_COUNT} records.`);
  }
  if ((catalog as { version?: unknown }).version !== SCENARIO_CATALOG_VERSION) {
    fail(`Scenario catalog version must be ${SCENARIO_CATALOG_VERSION}.`);
  }
  const events = (situations as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length === 0) fail("Situations catalog requires a non-empty events array.");
  if ((situations as { version?: unknown }).version !== SITUATIONS_CATALOG_VERSION) {
    fail(`Situations version must be ${SITUATIONS_CATALOG_VERSION}.`);
  }
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  const eventIds = new Set((events as Array<{ id?: unknown }>).map((event) => String(event.id)));
  const out: ScenarioManifestRecord[] = [];
  for (const record of records as Array<Record<string, unknown>>) {
    const id = String(record.id ?? "");
    const sourceFilename = String(record.sourceFilename ?? "");
    const referencePath = String(record.referencePath ?? "");
    const sha256 = String(record.sha256 ?? "");
    if (!id || seenIds.has(id)) fail(`Duplicate or empty scenario id: ${JSON.stringify(id)}.`);
    if (!SCENARIO_REF_FILENAMES.includes(sourceFilename as (typeof SCENARIO_REF_FILENAMES)[number]) || seenFiles.has(sourceFilename)) {
      fail(`Scenario ${id} has a duplicated or non-allowlisted source file: ${sourceFilename}.`);
    }
    assertSafePackagedPath(referencePath, `Scenario ${id} referencePath`);
    if (referencePath !== `${SCENARIO_REF_DIR}/${sourceFilename}`) {
      fail(`Scenario ${id} referencePath must be ${SCENARIO_REF_DIR}/${sourceFilename}.`);
    }
    if (!/^[a-f0-9]{64}$/.test(sha256)) fail(`Scenario ${id} has an invalid sha256 digest.`);
    if (!Number.isSafeInteger(record.sizeBytes) || (record.sizeBytes as number) <= 0) {
      fail(`Scenario ${id} has an invalid sizeBytes.`);
    }
    const compat = record.compatibleSituations;
    if (!Array.isArray(compat) || compat.length === 0 || compat.some((entry) => !eventIds.has(String(entry)))) {
      fail(`Scenario ${id} links an unknown or empty compatibleSituations list.`);
    }
    seenIds.add(id);
    seenFiles.add(sourceFilename);
    out.push({ id, sourceFilename, referencePath, sha256, sizeBytes: record.sizeBytes as number });
  }
  const missing = (SCENARIO_REF_FILENAMES as readonly string[]).filter((name) => !seenFiles.has(name));
  if (missing.length) fail(`Scenario catalog is missing allowlisted files: ${missing.join(", ")}.`);
  return out;
}

/** Byte-level reference check: hash + size against the catalog record. Never executes. */
export function validateScenarioReferenceBytes(bytes: Buffer, expected: ScenarioManifestRecord): void {
  if (!/^[a-f0-9]{64}$/.test(expected.sha256)) fail(`Scenario ${expected.id} has an invalid sha256 digest.`);
  if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes <= 0) {
    fail(`Scenario ${expected.id} has an invalid sizeBytes.`);
  }
  const digest = sha256Hex(bytes);
  if (bytes.byteLength !== expected.sizeBytes || digest !== expected.sha256) {
    fail(
      `Scenario ${expected.id} reference bytes do not match the catalog ` +
        `(size ${bytes.byteLength} vs ${expected.sizeBytes}, sha256 ${digest.slice(0, 12)}… vs ${expected.sha256.slice(0, 12)}…).`,
    );
  }
}
