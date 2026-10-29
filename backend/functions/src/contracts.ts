import { createHash } from "node:crypto";
import { CHEAP_DEMO_PRESET, ERROR_CODES, ErrorCode, REQUIRED_CAMERA_IDS } from "./config";

export type { ErrorCode };

export class BackendError extends Error {
  constructor(readonly errorCode: ErrorCode, message: string) {
    super(message);
    this.name = "BackendError";
  }
}

export interface Identity {
  partyId: string;
  deviceId: string;
  channelId: string;
}

export interface RequestGenerationInput extends Identity {
  jobId: string;
  idempotencyKey: string;
  presetId: typeof CHEAP_DEMO_PRESET.presetId;
}

export interface CanonicalClip {
  cameraId: (typeof REQUIRED_CAMERA_IDS)[number];
  objectPath: string;
  sha256: string;
  sizeBytes: number;
  durationMs: number;
  expiresAt: string;
}

export interface DeliveryManifest {
  partyId: string;
  channelId: string;
  version: number;
  schemaVersion: number;
  jobId: string;
  cameraClips: CanonicalClip[];
  createdAt?: unknown;
  expiresAt: string;
}

export interface AckInput extends Identity {
  manifestVersion: number;
  clipHashes: Record<string, string>;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function requireIdentity(value: unknown): Identity {
  if (!isRecord(value) || typeof value.partyId !== "string" || !value.partyId ||
      typeof value.deviceId !== "string" || !value.deviceId) {
    throw new BackendError("UNAUTHENTICATED", "A registered partyId and deviceId are required.");
  }
  const partyId = validateId(value.partyId, "partyId");
  const deviceId = validateId(value.deviceId, "deviceId");
  const channelId = typeof value.channelId === "string" && value.channelId
    ? validateId(value.channelId, "channelId")
    : "";
  return { partyId, deviceId, channelId };
}

export function parseRequestGeneration(value: unknown): RequestGenerationInput {
  const identity = requireIdentity(value);
  if (!identity.channelId) throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
  if (!isRecord(value)) throw new BackendError("INVALID_ARGUMENT", "Request payload must be an object.");
  const jobId = validateId(value.jobId, "jobId");
  const idempotencyKey = validateId(value.idempotencyKey, "idempotencyKey");
  if (value.presetId !== CHEAP_DEMO_PRESET.presetId) {
    throw new BackendError("INVALID_ARGUMENT", "Only the cheap_demo preset is supported.");
  }
  // Model and generation controls are fixed server-side; caller overrides are rejected.
  for (const [key, expected] of Object.entries(CHEAP_DEMO_PRESET)) {
    if (key in value && value[key] !== expected) {
      throw new BackendError("INVALID_ARGUMENT", `Unsupported ${key}.`);
    }
  }
  return { ...identity, jobId, idempotencyKey, presetId: CHEAP_DEMO_PRESET.presetId };
}

export function parseAck(value: unknown): AckInput {
  const identity = requireIdentity(value);
  if (!identity.channelId) throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
  if (!isRecord(value) || !Number.isSafeInteger(value.manifestVersion) || Number(value.manifestVersion) < 1) {
    throw new BackendError("INVALID_ARGUMENT", "A positive manifestVersion is required.");
  }
  if (!isRecord(value.clipHashes)) throw new BackendError("INVALID_ARGUMENT", "clipHashes must be an object.");
  const keys = Object.keys(value.clipHashes).sort();
  if (keys.join(",") !== [...REQUIRED_CAMERA_IDS].sort().join(",")) {
    throw new BackendError("MANIFEST_MISMATCH", "ACK must include one hash for each canonical camera clip.");
  }
  const clipHashes: Record<string, string> = {};
  for (const cameraId of REQUIRED_CAMERA_IDS) {
    const hash = value.clipHashes[cameraId];
    if (typeof hash !== "string" || !HASH_RE.test(hash)) {
      throw new BackendError("MANIFEST_MISMATCH", "ACK hashes must be canonical SHA-256 hex values.");
    }
    clipHashes[cameraId] = hash;
  }
  return { ...identity, manifestVersion: Number(value.manifestVersion), clipHashes };
}

export function validateId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new BackendError("INVALID_ARGUMENT", `${label} is invalid.`);
  }
  return value;
}

export function validateCanonicalClips(clips: unknown): asserts clips is CanonicalClip[] {
  if (!Array.isArray(clips) || clips.length !== REQUIRED_CAMERA_IDS.length) {
    throw new BackendError("MANIFEST_MISMATCH", "A manifest must contain exactly four camera clips.");
  }
  const byCamera = new Map<string, CanonicalClip>();
  for (const raw of clips) {
    if (!isRecord(raw) || typeof raw.cameraId !== "string" ||
        !REQUIRED_CAMERA_IDS.includes(raw.cameraId as (typeof REQUIRED_CAMERA_IDS)[number]) ||
        typeof raw.objectPath !== "string" || typeof raw.sha256 !== "string" || !HASH_RE.test(raw.sha256) ||
        !Number.isSafeInteger(raw.sizeBytes) || Number(raw.sizeBytes) <= 0 ||
        !Number.isSafeInteger(raw.durationMs) || Number(raw.durationMs) !== 2000 ||
        typeof raw.expiresAt !== "string" || !Number.isFinite(Date.parse(raw.expiresAt))) {
      throw new BackendError("MANIFEST_MISMATCH", "Manifest clip fields are invalid.");
    }
    if (byCamera.has(raw.cameraId)) throw new BackendError("MANIFEST_MISMATCH", "Duplicate camera clip.");
    byCamera.set(raw.cameraId, raw as unknown as CanonicalClip);
  }
  if (REQUIRED_CAMERA_IDS.some((cameraId) => !byCamera.has(cameraId))) {
    throw new BackendError("MANIFEST_MISMATCH", "Manifest camera set is incomplete.");
  }
}

export function canonicalManifestHash(manifest: Pick<DeliveryManifest, "partyId" | "channelId" | "version" | "cameraClips">): string {
  const canonical = {
    partyId: manifest.partyId,
    channelId: manifest.channelId,
    version: manifest.version,
    cameraClips: [...manifest.cameraClips]
      .sort((a, b) => a.cameraId.localeCompare(b.cameraId))
      .map(({ cameraId, sha256, sizeBytes, durationMs }) => ({ cameraId, sha256, sizeBytes, durationMs })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function ackIdempotencyKey(deviceId: string, channelId: string, manifestVersion: number): string {
  return createHash("sha256").update(`${deviceId}\n${channelId}\n${manifestVersion}`).digest("hex");
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}
