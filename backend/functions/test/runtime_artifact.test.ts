import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  assertLinuxX64Executable,
  assertMp4Container,
  installedPackageVersion,
  isLinuxX64Elf,
  readRuntimeManifest,
  sha256Hex,
  validateFixtureBytes,
} from "../tools/runtime_artifact";

const PACKAGE_ROOT = process.cwd();

function elfHeader(machine = 62, clazz = 2, data = 1): Buffer {
  const bytes = Buffer.alloc(64, 0);
  bytes[0] = 0x7f;
  bytes.write("ELF", 1);
  bytes[4] = clazz;
  bytes[5] = data;
  bytes[6] = 1;
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

test("ELF detection distinguishes real Linux x64 from truncated, wrong-arch, and foreign binaries", () => {
  assert.equal(isLinuxX64Elf(elfHeader()), true);
  assert.equal(isLinuxX64Elf(Buffer.alloc(19, 0)), false, "truncated header must not validate");
  assert.equal(isLinuxX64Elf(elfHeader(3)), false, "32-bit x86 machine must not validate");
  assert.equal(isLinuxX64Elf(elfHeader(62, 1)), false, "32-bit class must not validate");
  assert.equal(isLinuxX64Elf(elfHeader(62, 2, 2)), false, "big-endian data must not validate");
  const macho = Buffer.alloc(64, 0);
  macho.writeUInt32LE(0xfeedfacf, 0);
  assert.equal(isLinuxX64Elf(macho), false, "Mach-O must not validate as Linux ELF");
  assert.equal(isLinuxX64Elf(Buffer.from("not an executable at all")), false);
});

test("real packaged Linux binaries validate structurally without execution", () => {
  const candidates = [
    join(PACKAGE_ROOT, "runtime", "bin", "ffmpeg"),
    join(PACKAGE_ROOT, "node_modules", "@ffmpeg-installer", "linux-x64", "ffmpeg"),
  ];
  const binary = candidates.find((path) => existsSync(path));
  assert.ok(binary, "expected a prepared runtime binary or the installed pinned package");
  const bytes = assertLinuxX64Executable(binary, "FFmpeg probe");
  assert.ok(bytes.byteLength > 1024 * 1024);
  assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"));
  assert.throws(() => assertLinuxX64Executable(join(dirname(binary), "definitely-missing"), "missing"), /missing/);
  const scratch = mkdtempSync(join(tmpdir(), "artifact-truncated-"));
  try {
    const truncated = join(scratch, "ffmpeg");
    writeFileSync(truncated, bytes.subarray(0, 1024));
    assert.throws(() => assertLinuxX64Executable(truncated, "truncated"), /small|ELF/);
    const foreign = join(scratch, "foreign");
    writeFileSync(foreign, Buffer.alloc(2 * 1024 * 1024, 0x41));
    assert.throws(() => assertLinuxX64Executable(foreign, "foreign"), /not a little-endian Linux x86_64 ELF/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("fixture byte validation matches the real manifest and rejects tampering", () => {
  const manifestPath = resolve(PACKAGE_ROOT, "../../apps/tv_app/assets/fixture_manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    clips: Array<{ cameraId: string; sha256: string; sizeBytes: number; durationMs: number }>;
  };
  const first = manifest.clips[0];
  const bytes = readFileSync(resolve(PACKAGE_ROOT, "../../apps/tv_app/assets/cam01.mp4"));
  assertMp4Container(bytes, "cam01");
  validateFixtureBytes(bytes, first);
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => validateFixtureBytes(tampered, first), /does not match its bytes/);
  assert.throws(() => validateFixtureBytes(Buffer.from("plain text, not mp4"), first), /MP4|metadata/);
  assert.throws(() => validateFixtureBytes(bytes, { ...first, sha256: "0".repeat(64) }), /does not match its bytes/);
  assert.throws(() => readRuntimeManifest(join(tmpdir(), "no-such-runtime-manifest.json")), /missing/);
});

test("pinned installer packages resolve to the exact locked versions", () => {
  const ffmpeg = installedPackageVersion(
    { packageName: "@ffmpeg-installer/linux-x64", binary: "ffmpeg", expectedVersion: "4.1.0" },
    PACKAGE_ROOT,
  );
  assert.equal(ffmpeg.version, "4.1.0");
  assert.ok(existsSync(join(ffmpeg.directory, "ffmpeg")));
  assert.throws(
    () => installedPackageVersion(
      { packageName: "@ffmpeg-installer/linux-x64", binary: "ffmpeg", expectedVersion: "0.0.0" },
      PACKAGE_ROOT,
    ),
    /pinned/,
  );
  assert.throws(
    () => installedPackageVersion(
      { packageName: "@does-not-exist/linux-x64", binary: "ffmpeg", expectedVersion: "1.0.0" },
      mkdtempSync(join(tmpdir(), "artifact-empty-")),
    ),
    /not installed/,
  );
});
