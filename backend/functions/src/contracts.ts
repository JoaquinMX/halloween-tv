import { createHash } from "node:crypto";
import { CAMEO_DEMO_PRESET, CHEAP_DEMO_PRESET, ERROR_CODES, ErrorCode, REQUIRED_CAMERA_IDS, SUPPORTED_CAMERA_COUNTS, expectedCameraIds } from "./config";

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
  presetId: typeof CHEAP_DEMO_PRESET.presetId | typeof CAMEO_DEMO_PRESET.presetId;
  /** Optional consent-bound guest media submission bound at request time. */
  guestMediaId?: string;
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
  /** Firestore timestamp in storage; callable serialization converts it to ISO. */
  createdAt?: unknown;
  expiresAt: string;
}

export interface CurrentManifestInput extends Identity {}

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
  if (value.presetId === CAMEO_DEMO_PRESET.presetId) {
    // STEP 2 cameo batch: separate server lock, guest-bound only. Text-only
    // requests for this preset are rejected; prompts stay fixed server-side.
    for (const [key, expected] of Object.entries(CAMEO_DEMO_PRESET)) {
      if (key in value && value[key] !== expected) {
        throw new BackendError("INVALID_ARGUMENT", `Unsupported ${key}.`);
      }
    }
    if (!("guestMediaId" in value) || typeof value.guestMediaId !== "string" || !value.guestMediaId) {
      throw new BackendError("INVALID_ARGUMENT", "The cameo_demo preset requires a consent-bound guestMediaId.");
    }
    validateId(value.guestMediaId, "guestMediaId");
    return { ...identity, jobId, idempotencyKey, presetId: CAMEO_DEMO_PRESET.presetId, guestMediaId: value.guestMediaId };
  }
  if (value.presetId !== CHEAP_DEMO_PRESET.presetId) {
    throw new BackendError("INVALID_ARGUMENT", "Only the cheap_demo preset is supported.");
  }
  // Model and generation controls are fixed server-side; caller overrides are rejected.
  for (const [key, expected] of Object.entries(CHEAP_DEMO_PRESET)) {
    if (key in value && value[key] !== expected) {
      throw new BackendError("INVALID_ARGUMENT", `Unsupported ${key}.`);
    }
  }
  if ("guestMediaId" in value && value.guestMediaId !== undefined) {
    if (typeof value.guestMediaId !== "string" || !value.guestMediaId) {
      throw new BackendError("INVALID_ARGUMENT", "guestMediaId is invalid.");
    }
    validateId(value.guestMediaId, "guestMediaId");
    return { ...identity, jobId, idempotencyKey, presetId: CHEAP_DEMO_PRESET.presetId, guestMediaId: value.guestMediaId };
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
  // 1/2/4-camera layouts: the ACK key set must exactly equal the first-N
  // canonical prefix for one supported count. Extra hashes (beyond the
  // manifest's prefix) are rejected here; exact match against the actual
  // manifest (same length + same hashes) is enforced at ACK acceptance.
  const keys = Object.keys(value.clipHashes).sort();
  const supportedKeySets = (SUPPORTED_CAMERA_COUNTS as readonly number[]).map(
    (count) => [...expectedCameraIds(count)].sort().join(","),
  );
  if (!supportedKeySets.includes(keys.join(","))) {
    throw new BackendError("MANIFEST_MISMATCH", "ACK must include one hash for each canonical camera clip (1, 2, or 4 clips, first-N prefix).");
  }
  const clipHashes: Record<string, string> = {};
  for (const cameraId of keys) {
    const hash = (value.clipHashes as Record<string, unknown>)[cameraId];
    if (typeof hash !== "string" || !HASH_RE.test(hash)) {
      throw new BackendError("MANIFEST_MISMATCH", "ACK hashes must be canonical SHA-256 hex values.");
    }
    clipHashes[cameraId] = hash;
  }
  return { ...identity, manifestVersion: Number(value.manifestVersion), clipHashes };
}

export function parseCurrentManifestInput(value: unknown): CurrentManifestInput {
  const identity = requireIdentity(value);
  if (!identity.channelId) throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
  return identity;
}

export interface JoinPartyInput extends Identity {
  joinPin?: string;
}

/** Exactly six ASCII digits; leading zeros are significant. */
export const JOIN_PIN_RE = /^[0-9]{6}$/;

export function parseJoinPartyInput(value: unknown): JoinPartyInput {
  if (!isRecord(value) || typeof value.partyId !== "string" || !value.partyId ||
      typeof value.deviceId !== "string" || !value.deviceId) {
    throw new BackendError("UNAUTHENTICATED", "A registered partyId and deviceId are required.");
  }
  const partyId = validateId(value.partyId, "partyId");
  const deviceId = validateId(value.deviceId, "deviceId");
  if (typeof value.channelId !== "string" || !value.channelId) {
    throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
  }
  const channelId = validateId(value.channelId, "channelId");
  if (value.joinPin === undefined) {
    return { partyId, deviceId, channelId };
  }
  if (typeof value.joinPin !== "string" || !JOIN_PIN_RE.test(value.joinPin)) {
    throw new BackendError("INVALID_ARGUMENT", "joinPin must be six digits.");
  }
  return { partyId, deviceId, channelId, joinPin: value.joinPin };
}

export function validateId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new BackendError("INVALID_ARGUMENT", `${label} is invalid.`);
  }
  return value;
}

export function validateCanonicalClips(clips: unknown): asserts clips is CanonicalClip[] {
  if (!Array.isArray(clips) || !(SUPPORTED_CAMERA_COUNTS as readonly number[]).includes(clips.length)) {
    throw new BackendError("MANIFEST_MISMATCH", "A manifest must contain 1, 2, or 4 camera clips (four is the default layout).");
  }
  const expected = new Set<string>([...expectedCameraIds(clips.length)]);
  const byCamera = new Map<string, CanonicalClip>();
  for (const raw of clips) {
    if (!isRecord(raw) || typeof raw.cameraId !== "string" ||
        !expected.has(raw.cameraId) ||
        typeof raw.objectPath !== "string" || typeof raw.sha256 !== "string" || !HASH_RE.test(raw.sha256) ||
        !Number.isSafeInteger(raw.sizeBytes) || Number(raw.sizeBytes) <= 0 ||
        (!Number.isSafeInteger(raw.durationMs) || (Number(raw.durationMs) !== 2000 && Number(raw.durationMs) !== 5000)) ||
        typeof raw.expiresAt !== "string" || !Number.isFinite(Date.parse(raw.expiresAt))) {
      throw new BackendError("MANIFEST_MISMATCH", "Manifest clip fields are invalid.");
    }
    if (byCamera.has(raw.cameraId)) throw new BackendError("MANIFEST_MISMATCH", "Duplicate camera clip.");
    byCamera.set(raw.cameraId, raw as unknown as CanonicalClip);
  }
  // Prefix rule: reordered valid clips are accepted, but gaps (e.g.
  // {CAM-01, CAM-03} for count 2) and unknown cameras are rejected.
  if (byCamera.size !== expected.size || [...expected].some((cameraId) => !byCamera.has(cameraId))) {
    throw new BackendError("MANIFEST_MISMATCH", "Manifest camera set must equal the first-N canonical cameras.");
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

// ---------------------------------------------------------------------------
// Host administration (cycle-12, partition p1).
//
// The companion uses a dedicated host entry screen (HostEntryScreen with
// Scan Host QR + explicit Join-as-guest route; see partition p4/5 + README).
// Rationale: guest PIN admission is intentionally broad (anyone who sees the
// TV can join as a guest with full party-scoped read/generate/ACK power),
// so host administration must never be reachable through the guest PIN or a
// client-supplied role string. Host access is a separate server-minted,
// short-lived invite capability redeemable once, bound to party/channel/
// expiry, with the host role assigned server-side only.
//
// Callable surface (all exported through index.ts + runtime.ts):
//   createHostInvite  (TV-only)  -> { inviteToken, expiresAt }
//   joinHost          (phone)     -> { role: "host" } (separate device identity)
//   listHostVideos    (host-only) -> seed catalog entries
//   generateHostVideo (host-only) -> fixed-preset queued generation + seed entry
//   getHostVideoPreview (host-only) -> signed preview URLs (never persisted)
//   deleteHostVideo   (host-only) -> delete seeds + objects, revoke manifests
// ---------------------------------------------------------------------------

/** Server-assigned device roles. Clients can never self-assign "host" or "tv". */
export const DEVICE_ROLES = ["guest", "host", "tv"] as const;
export type DeviceRole = (typeof DEVICE_ROLES)[number];

export interface CreateHostInviteInput extends Identity {}

export interface CreateHostInviteResult {
  partyId: string;
  channelId: string;
  inviteToken: string;
  expiresAt: string;
}

export interface JoinHostInput extends Identity {
  inviteToken: string;
}

export interface JoinHostResult {
  partyId: string;
  deviceId: string;
  channelId: string;
  role: "host";
  status: "active";
  created: boolean;
}

export interface ListHostVideosInput extends Identity {}

export type HostSeedStatus = "queued" | "running" | "ready" | "failed" | "deleted";

export interface HostSeedEntry {
  seedId: string;
  partyId: string;
  channelId: string;
  status: HostSeedStatus;
  jobId: string;
  createdAt: string;
  expiresAt: string;
  previewAvailable: boolean;
  cameraIds: string[];
}

export interface GenerateHostVideoInput extends Identity {
  seedId: string;
  idempotencyKey: string;
  presetId: typeof CHEAP_DEMO_PRESET.presetId | typeof CAMEO_DEMO_PRESET.presetId;
  guestMediaId?: string;
}

export interface GenerateHostVideoResult {
  seedId: string;
  jobId: string;
  state: string;
  created: boolean;
}

export interface GetHostVideoPreviewInput extends Identity {
  seedId: string;
}

export interface GetHostVideoPreviewResult {
  seedId: string;
  expiresAt: string;
  clips: Array<{ cameraId: string; sha256: string; url: string; expiresAt: string }>;
}

export interface DeleteHostVideoInput extends Identity {
  seedIds: string[];
}

export interface DeleteHostVideoResult {
  deletedSeedIds: string[];
  deletedObjects: string[];
  revokedManifest: boolean;
}

export function parseCreateHostInviteInput(value: unknown): CreateHostInviteInput {
  const identity = requireIdentity(value);
  if (!identity.channelId) throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
  return identity;
}

export function parseJoinHostInput(value: unknown): JoinHostInput {
  if (!isRecord(value) || typeof value.partyId !== "string" || !value.partyId ||
      typeof value.deviceId !== "string" || !value.deviceId) {
    throw new BackendError("UNAUTHENTICATED", "A registered partyId and deviceId are required.");
  }
  const partyId = validateId(value.partyId, "partyId");
  const deviceId = validateId(value.deviceId, "deviceId");
  if (typeof value.channelId !== "string" || !value.channelId) {
    throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
  }
  const channelId = validateId(value.channelId, "channelId");
  // The invite token is a server-minted capability, never a guest PIN: PIN
  // shape alone must not redeem host access, and client-supplied role
  // strings are ignored (the server assigns "host" transactionally).
  if (typeof value.inviteToken !== "string" || value.inviteToken.trim() === "" || value.inviteToken.length > 256) {
    throw new BackendError("INVALID_ARGUMENT", "inviteToken is required.");
  }
  if (JOIN_PIN_RE.test(value.inviteToken)) {
    throw new BackendError("INVALID_ARGUMENT", "inviteToken must be a host invite, not a guest PIN.");
  }
  return { partyId, deviceId, channelId, inviteToken: value.inviteToken };
}

export function parseListHostVideosInput(value: unknown): ListHostVideosInput {
  const identity = requireIdentity(value);
  if (!identity.channelId) throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
  return identity;
}

export function parseGenerateHostVideoInput(value: unknown): GenerateHostVideoInput {
  const identity = requireIdentity(value);
  if (!identity.channelId) throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
  if (!isRecord(value)) throw new BackendError("INVALID_ARGUMENT", "Request payload must be an object.");
  const seedId = validateId(value.seedId, "seedId");
  const idempotencyKey = validateId(value.idempotencyKey, "idempotencyKey");
  // Fixed-preset queue only: same lock as requestGeneration (cheap_demo or
  // cameo_demo with its consent binding); caller overrides are rejected.
  if (value.presetId !== undefined &&
      value.presetId !== CHEAP_DEMO_PRESET.presetId &&
      value.presetId !== CAMEO_DEMO_PRESET.presetId) {
    throw new BackendError("INVALID_ARGUMENT", "Only the fixed generation presets are supported.");
  }
  const presetId = (value.presetId ?? CHEAP_DEMO_PRESET.presetId) as GenerateHostVideoInput["presetId"];
  if (presetId === CAMEO_DEMO_PRESET.presetId) {
    if (typeof value.guestMediaId !== "string" || !value.guestMediaId) {
      throw new BackendError("INVALID_ARGUMENT", "The cameo_demo preset requires a consent-bound guestMediaId.");
    }
    validateId(value.guestMediaId, "guestMediaId");
    return { ...identity, seedId, idempotencyKey, presetId, guestMediaId: value.guestMediaId };
  }
  if (value.guestMediaId !== undefined) {
    if (typeof value.guestMediaId !== "string" || !value.guestMediaId) {
      throw new BackendError("INVALID_ARGUMENT", "guestMediaId is invalid.");
    }
    validateId(value.guestMediaId, "guestMediaId");
    return { ...identity, seedId, idempotencyKey, presetId, guestMediaId: value.guestMediaId };
  }
  return { ...identity, seedId, idempotencyKey, presetId };
}

export function parseGetHostVideoPreviewInput(value: unknown): GetHostVideoPreviewInput {
  const identity = requireIdentity(value);
  if (!identity.channelId) throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
  if (!isRecord(value) || typeof value.seedId !== "string" || !value.seedId) {
    throw new BackendError("INVALID_ARGUMENT", "seedId is required.");
  }
  return { ...identity, seedId: validateId(value.seedId, "seedId") };
}

export function parseDeleteHostVideoInput(value: unknown): DeleteHostVideoInput {
  const identity = requireIdentity(value);
  if (!identity.channelId) throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
  if (!isRecord(value) || !Array.isArray(value.seedIds) || value.seedIds.length === 0 || value.seedIds.length > 32) {
    throw new BackendError("INVALID_ARGUMENT", "seedIds must be a non-empty list (max 32).");
  }
  const seen = new Set<string>();
  const seedIds: string[] = [];
  for (const raw of value.seedIds) {
    const seedId = validateId(raw, "seedId");
    if (seen.has(seedId)) throw new BackendError("INVALID_ARGUMENT", "Duplicate seedId.");
    seen.add(seedId);
    seedIds.push(seedId);
  }
  return { ...identity, seedIds };
}
