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
//   createHostInvite  (TV-only)  -> { inviteToken, pairingCode, expiresAt }
//   joinHost          (phone)     -> { role: "host" } (separate device identity)
//   revokeHostDevice  (TV-only)  -> { status: "revoked" } + audit record
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
  /** Server-minted 6-digit pairing code shown next to the HOST QR on the TV. */
  pairingCode: string;
  expiresAt: string;
}

export interface JoinHostInput extends Identity {
  inviteToken: string;
  /** 6-digit pairing code displayed next to the HOST QR; required. */
  pairingCode: string;
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
  // The pairing code is required and shape-checked here, but a missing or
  // wrong code is denied with the SAME generic FORBIDDEN message as an
  // unknown invite at redemption time, so callers cannot probe which half
  // of the credential failed (no oracle).
  if (typeof value.pairingCode !== "string" || !JOIN_PIN_RE.test(value.pairingCode)) {
    throw new BackendError("FORBIDDEN", "Host invite is invalid or expired.");
  }
  return { partyId, deviceId, channelId, inviteToken: value.inviteToken, pairingCode: value.pairingCode };
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

// ---------------------------------------------------------------------------
// Host pairing + capacity + revocation (cycle-12 fix-1, backend authoritative).
// ---------------------------------------------------------------------------

/** Max active host devices per party: further redemption is denied until a host is revoked. */
export const HOST_MAX_DEVICES = 3;

/** Pairing-code shape: exactly six ASCII digits (leading zeros significant). */
export const PAIRING_CODE_RE = /^[0-9]{6}$/;

/**
 * Host-originated source consent: distinct textVersion/purpose pair for
 * host-submitted source media, namespaced away from the guest cameo pair
 * (`v1` / `guest_cameo`). Consent records carrying this pair include an
 * attestation copy (see guest_upload.ts) and are enforced in eligibility
 * for host submissions. The guest pair is unchanged.
 */
export const HOST_SOURCE_CONSENT_TEXT_VERSION = "host_source_v1";
export const HOST_SOURCE_CONSENT_PURPOSE = "host_source";

/** Returns true for either supported consent pair (guest cameo or host source). */
export function isSupportedConsent(textVersion: unknown, purpose: unknown): boolean {
  return (
    (textVersion === "v1" && purpose === "guest_cameo") ||
    (textVersion === HOST_SOURCE_CONSENT_TEXT_VERSION && purpose === HOST_SOURCE_CONSENT_PURPOSE)
  );
}

/** Returns true only for the host-originated source consent pair. */
export function isHostSourceConsent(textVersion: unknown, purpose: unknown): boolean {
  return textVersion === HOST_SOURCE_CONSENT_TEXT_VERSION && purpose === HOST_SOURCE_CONSENT_PURPOSE;
}

export interface RevokeHostDeviceInput extends Identity {
  targetDeviceId: string;
}

export interface RevokeHostDeviceResult {
  partyId: string;
  targetDeviceId: string;
  status: "revoked";
}

export function parseRevokeHostDeviceInput(value: unknown): RevokeHostDeviceInput {
  const identity = requireIdentity(value);
  if (!identity.channelId) throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
  if (!isRecord(value) || typeof value.targetDeviceId !== "string" || !value.targetDeviceId) {
    throw new BackendError("INVALID_ARGUMENT", "targetDeviceId is required.");
  }
  return { ...identity, targetDeviceId: validateId(value.targetDeviceId, "targetDeviceId") };
}

// ---------------------------------------------------------------------------
// Cartoon catalog pipeline (cycle-13, backend-owned).
//
// Backend-owned cartoon pipeline on the Alibaba Singapore Token Plan ONLY:
// stills via `qwen-image-3.0-pro`, video via `wan3.0-video` STANDARD.
// Never Google/Veo/Imagen. Proven cheap_demo video controls stay pinned
// (2s/480P/silent/no-watermark/prompt_extend false); cheap_demo + cameo_demo
// preset locks are never altered or silently upgraded by this section.
// Cartoon constants live here (not config.ts) so this partition integrates
// shared contract changes exclusively without touching other partitions.
// ---------------------------------------------------------------------------

/** Image-stage preset: cartoon still from portrait + scene/style references. */
export const CARTOON_STILL_PRESET = Object.freeze({
  presetId: "cartoon_still" as const,
  modelId: "qwen-image-3.0-pro" as const,
  region: "singapore" as const,
  provider: "alibaba" as const,
});

/** Video-stage preset: animate the generated still (STANDARD control). */
export const CARTOON_VIDEO_PRESET = Object.freeze({
  presetId: "cartoon_video" as const,
  modelId: "wan3.0-video" as const,
  region: "singapore" as const,
  resolution: "480P" as const,
  secondsOut: 2 as const,
  aspectRatio: "16:9" as const,
  audio: false as const,
  outputs: 1 as const,
  autoUpscale: false as const,
  promptExtend: false as const,
  watermark: false as const,
  videoControl: "STANDARD" as const,
});

/** Sixteen image-backed catalog scenarios, fixed plan IDs/versions/seeds. */
export interface CartoonScenario {
  scenarioId: string;
  stillPlanId: string;
  videoPlanId: string;
  version: number;
  seed: number;
}

export const CARTOON_CATALOG_SCENARIOS: readonly CartoonScenario[] = Object.freeze(
  Array.from({ length: 16 }, (_, index) => {
    const slot = String(index + 1).padStart(2, "0");
    return Object.freeze({
      scenarioId: `cartoon-${slot}`,
      stillPlanId: `cartoon-still-plan-${slot}`,
      videoPlanId: `cartoon-video-plan-${slot}`,
      version: 1,
      seed: 130100 + index,
    });
  }),
);

/** Scoped provenance kinds for wall delivery authorization. */
export type DeliveryProvenanceKind =
  | "guest"
  | "operator"
  | "host"
  | "legacy"
  | "cartoon-chain"
  | "text-only";

/** Delivery diagnostics stage: failures carry an explicit `[stage]` prefix. */
export type DeliveryFailureStage =
  | "manifest"
  | "authorization"
  | "signing"
  | "download"
  | "hash"
  | "ack";

/** Prefixes a backend error message with its diagnostics stage. */
export function deliveryFailure(stage: DeliveryFailureStage, errorCode: ErrorCode, message: string): BackendError {
  return new BackendError(errorCode, `[${stage}] ${message}`);
}

/**
 * Scoped provenance evaluation for wall delivery.
 *
 * Replaces blanket guest-consent assumptions: approved legacy / operator /
 * host seed artifacts are deliverable WITHOUT fabricated mobile consent,
 * while withdrawn, expired, deleted, changed-source, unknown, or
 * unauthorized bindings receive explicit errors. Database read failures
 * fail CLOSED (INTERNAL) and are never treated as "no consent needed".
 */
export interface ProvenanceEvaluationInput {
  job: Record<string, unknown>;
  guest?: Record<string, unknown> | undefined;
  guestReadError?: unknown;
  seed?: Record<string, unknown> | undefined;
  seedReadError?: unknown;
  nowMs: number;
}

function provenanceExpiryMs(value: unknown): number | undefined {
  if (value && typeof value === "object" && "toDate" in value &&
      typeof (value as { toDate?: unknown }).toDate === "function") {
    return ((value as { toDate: () => Date }).toDate()).getTime();
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function guestBindingOf(job: Record<string, unknown>): {
  submissionId: string;
  sourceHash: string;
  consentRevision: string;
} | undefined {
  const guest = job.guestMedia as Record<string, unknown> | undefined;
  if (!guest || typeof guest.submissionId !== "string" ||
      typeof guest.sourceHash !== "string" || typeof guest.consentRevision !== "string") {
    return undefined;
  }
  return { submissionId: guest.submissionId, sourceHash: guest.sourceHash, consentRevision: guest.consentRevision };
}

function seedBindingOf(job: Record<string, unknown>): {
  seedId: string;
  kind: string;
} | undefined {
  const seed = job.seedProvenance as Record<string, unknown> | undefined;
  if (!seed || typeof seed.seedId !== "string" || typeof seed.kind !== "string") return undefined;
  return { seedId: seed.seedId, kind: seed.kind };
}

/** True only for an explicitly supported legacy/operator/host seed artifact. */
export function isExplicitlySupportedLegacyArtifact(
  job: Record<string, unknown>,
  seed: Record<string, unknown> | undefined,
): boolean {
  if (!seed) return false;
  const binding = seedBindingOf(job);
  if (!binding) return false;
  if (!["legacy", "operator", "host"].includes(binding.kind)) return false;
  if (seed.seedId !== binding.seedId) return false;
  if (seed.partyId !== job.partyId || seed.channelId !== job.channelId) return false;
  if (seed.status === "deleted") return false;
  if (seed.status === "failed" || seed.status === "expired" || seed.status === "withdrawn") return false;
  if (seed.status !== "ready" && seed.status !== "approved") return false;
  if (seed.operatorApproved !== true && (seed as Record<string, unknown>).approved !== true) return false;
  return true;
}

/**
 * Requires a completed still-to-video chain with matching stage provenance
 * before a cartoon job may publish. Throws MANIFEST_MISMATCH otherwise.
 */
export function assertCartoonChainComplete(job: Record<string, unknown>): void {
  const chain = job.cartoonChain as Record<string, unknown> | undefined;
  if (!chain) {
    throw deliveryFailure("manifest", "MANIFEST_MISMATCH", "Cartoon job is missing its still-to-video chain provenance.");
  }
  if (chain.stillStatus !== "completed") {
    throw deliveryFailure("manifest", "MANIFEST_MISMATCH", "Cartoon still stage is not completed.");
  }
  if (chain.videoStatus !== undefined && chain.videoStatus !== "completed" && chain.videoStatus !== "staged") {
    throw deliveryFailure("manifest", "MANIFEST_MISMATCH", "Cartoon video stage is not completed.");
  }
  if (typeof chain.stillSha256 !== "string" || !/^[a-f0-9]{64}$/.test(chain.stillSha256)) {
    throw deliveryFailure("manifest", "MANIFEST_MISMATCH", "Cartoon still hash is missing or malformed.");
  }
  if (chain.videoStillSha256 !== undefined && chain.videoStillSha256 !== chain.stillSha256) {
    throw deliveryFailure("manifest", "MANIFEST_MISMATCH", "Cartoon video stage does not match the generated still.");
  }
  if (typeof chain.portraitSubmissionId === "string" && chain.portraitSubmissionId !== "" &&
      (typeof chain.portraitSourceHash !== "string" || typeof chain.portraitConsentRevision !== "string")) {
    throw deliveryFailure("manifest", "MANIFEST_MISMATCH", "Cartoon portrait stage provenance is incomplete.");
  }
}

/** Scoped provenance gate shared by publish-time and pre-URL checks. */
export function evaluateDeliveryProvenance(input: ProvenanceEvaluationInput): DeliveryProvenanceKind {
  const { job, nowMs } = input;
  if ((job as Record<string, unknown>).hostDeleted === true) {
    throw deliveryFailure("authorization", "FORBIDDEN", "Seed video was deleted; delivery is refused.");
  }
  // New cartoon jobs: completed still-to-video chain + matching provenance.
  if ((job as Record<string, unknown>).cartoonChain !== undefined) {
    assertCartoonChainComplete(job);
    const chain = (job as Record<string, unknown>).cartoonChain as Record<string, unknown>;
    // The portrait side of the chain keeps scoped consent: when the chain
    // cites a guest portrait, that binding is evaluated exactly like a
    // guest job; operator/host portraits pass on their seed approval.
    if (typeof chain.portraitSubmissionId === "string" && chain.portraitSubmissionId !== "") {
      if (input.guestReadError) {
        throw deliveryFailure("authorization", "INTERNAL", "Portrait consent evidence is unreadable; failing closed.");
      }
      const guest = input.guest;
      if (!guest) {
        throw deliveryFailure("authorization", "FORBIDDEN", "Cartoon portrait consent is no longer eligible for delivery.");
      }
      assertGuestProvenance(job, guest, String(chain.portraitSubmissionId), nowMs);
    }
    return "cartoon-chain";
  }
  const guestBinding = guestBindingOf(job);
  const seedBinding = seedBindingOf(job);
  if (guestBinding) {
    if (input.guestReadError) {
      throw deliveryFailure("authorization", "INTERNAL", "Guest consent evidence is unreadable; failing closed.");
    }
    const guest = input.guest;
    if (!guest) {
      throw deliveryFailure("authorization", "FORBIDDEN", "Guest consent is no longer eligible for delivery.");
    }
    assertGuestProvenance(job, guest, guestBinding.submissionId, nowMs);
    return "guest";
  }
  if (seedBinding) {
    if (input.seedReadError) {
      throw deliveryFailure("authorization", "INTERNAL", "Seed authorization evidence is unreadable; failing closed.");
    }
    const seed = input.seed;
    if (!seed) {
      throw deliveryFailure("authorization", "NOT_FOUND", `Seed artifact ${seedBinding.seedId} is unknown; delivery is refused.`);
    }
    assertSeedProvenance(job, seed, nowMs);
    return seedBinding.kind as DeliveryProvenanceKind;
  }
  // Text-only jobs carry no consent binding and remain deliverable.
  return "text-only";
}

function assertGuestProvenance(
  job: Record<string, unknown>,
  guest: Record<string, unknown>,
  submissionId: string,
  nowMs: number,
): void {
  const binding = guestBindingOf(job);
  if (guest.submissionId !== undefined && guest.submissionId !== submissionId) {
    throw deliveryFailure("authorization", "FORBIDDEN", "Guest media binding is not authorized for this job.");
  }
  if ((guest as Record<string, unknown>).tombstone === true || guest.status === "withdrawn") {
    throw deliveryFailure("authorization", "FORBIDDEN", "Guest consent was withdrawn; this manifest is revoked.");
  }
  if (guest.status === "expired") {
    throw deliveryFailure("authorization", "CLIP_EXPIRED", "Guest consent window has expired.");
  }
  if (guest.status !== "eligible") {
    throw deliveryFailure("authorization", "FORBIDDEN", "Guest consent is no longer eligible for delivery.");
  }
  const consent = guest.consent as Record<string, unknown> | undefined;
  if (!consent || consent.accepted !== true ||
      !isSupportedConsent(consent.textVersion, consent.purpose)) {
    throw deliveryFailure("authorization", "FORBIDDEN", "Guest consent is not recorded for delivery.");
  }
  if (binding && (guest.sourceHash !== binding.sourceHash || guest.consentRevision !== binding.consentRevision)) {
    throw deliveryFailure("authorization", "FORBIDDEN", "Guest media changed while the job was running.");
  }
  if (guest.partyId !== undefined && guest.partyId !== job.partyId) {
    throw deliveryFailure("authorization", "FORBIDDEN", "Guest media is not authorized for this party and channel.");
  }
  if (guest.channelId !== undefined && guest.channelId !== job.channelId) {
    throw deliveryFailure("authorization", "FORBIDDEN", "Guest media is not authorized for this party and channel.");
  }
  const expiry = provenanceExpiryMs(guest.expiresAt);
  if (!Number.isFinite(expiry) || (expiry as number) <= nowMs) {
    throw deliveryFailure("authorization", "FORBIDDEN", "Guest consent window has expired.");
  }
}

function assertSeedProvenance(
  job: Record<string, unknown>,
  seed: Record<string, unknown>,
  nowMs: number,
): void {
  const binding = seedBindingOf(job);
  if (!binding) {
    throw deliveryFailure("authorization", "FORBIDDEN", "Seed binding is missing; delivery is refused.");
  }
  if (seed.seedId !== binding.seedId) {
    throw deliveryFailure("authorization", "FORBIDDEN", "Seed artifact is not authorized for this job.");
  }
  if (seed.partyId !== job.partyId || seed.channelId !== job.channelId) {
    throw deliveryFailure("authorization", "FORBIDDEN", "Seed video is outside the registered party and channel.");
  }
  if (seed.status === "deleted") {
    throw deliveryFailure("authorization", "NOT_FOUND", "Seed video does not exist.");
  }
  if (seed.status === "withdrawn") {
    throw deliveryFailure("authorization", "FORBIDDEN", "Seed consent was withdrawn; delivery is refused.");
  }
  if (seed.status === "failed" || seed.status === "expired") {
    throw deliveryFailure("authorization", "NOT_FOUND", "Seed video is no longer available.");
  }
  const expiry = provenanceExpiryMs(seed.expiresAt);
  if (Number.isFinite(expiry) && (expiry as number) <= nowMs) {
    throw deliveryFailure("authorization", "CLIP_EXPIRED", "Seed video has expired.");
  }
  if (!isExplicitlySupportedLegacyArtifact(job, seed)) {
    throw deliveryFailure("authorization", "FORBIDDEN", "Seed artifact is not an explicitly supported legacy authorization.");
  }
}

/**
 * Pins the cartoon video controls to the proven cheap_demo envelope plus the
 * provider's STANDARD video control. Any deviation is rejected so historical
 * jobs are never silently upgraded and the Token Plan surface stays fixed.
 */
export function validateCartoonVideoControls(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon video controls must be an object.");
  }
  const controls = value as Record<string, unknown>;
  const expected: Record<string, unknown> = {
    modelId: CARTOON_VIDEO_PRESET.modelId,
    region: CARTOON_VIDEO_PRESET.region,
    resolution: CARTOON_VIDEO_PRESET.resolution,
    secondsOut: CARTOON_VIDEO_PRESET.secondsOut,
    aspectRatio: CARTOON_VIDEO_PRESET.aspectRatio,
    audio: CARTOON_VIDEO_PRESET.audio,
    outputs: CARTOON_VIDEO_PRESET.outputs,
    autoUpscale: CARTOON_VIDEO_PRESET.autoUpscale,
  };
  for (const [field, want] of Object.entries(expected)) {
    if (field in controls && controls[field] !== want) {
      throw new BackendError("INVALID_ARGUMENT", `Unsupported cartoon video ${field}; only the fixed cartoon preset is allowed.`);
    }
  }
  if ("promptExtend" in controls && controls.promptExtend !== false) {
    throw new BackendError("INVALID_ARGUMENT", "Prompt extension is disabled for cartoon video.");
  }
  if ("watermark" in controls && controls.watermark !== false) {
    throw new BackendError("INVALID_ARGUMENT", "Watermarks are disabled for cartoon video.");
  }
  if ("videoControl" in controls && controls.videoControl !== CARTOON_VIDEO_PRESET.videoControl) {
    throw new BackendError("INVALID_ARGUMENT", "Only the STANDARD cartoon video control is supported.");
  }
  if ("modelId" in controls && typeof controls.modelId === "string" &&
      /google|veo|imagen/i.test(controls.modelId)) {
    throw new BackendError("INVALID_ARGUMENT", "Only the Alibaba Singapore Token Plan models are supported.");
  }
}
