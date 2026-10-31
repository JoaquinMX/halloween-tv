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
