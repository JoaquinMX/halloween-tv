import { BackendError, HOST_SOURCE_CONSENT_PURPOSE, HOST_SOURCE_CONSENT_TEXT_VERSION } from "./contracts";
import {
  GUEST_CONSENT_PURPOSE,
  GUEST_CONSENT_TEXT_VERSION,
} from "./config";

/**
 * Versioned consent provenance (cycle-13 p3).
 *
 * Four origins are distinct and never interchangeable:
 *   legacy_seed      — historical seed-catalog entry predating per-subject
 *                      mobile consent. May carry explicit operator/host
 *                      approval for DELIVERY of that existing artifact only.
 *   operator_approval— explicit owner/operator approval recorded server-side.
 *   host_approval    — explicit host approval recorded server-side via the
 *                      registered-host path (never a client role string).
 *   guest_mobile     — bucket origin for authenticated server upload-path
 *                      evidence for guest-submitted cameo media
 *                      (v1/guest_cameo, actorRole guest).
 *   host_source     — authenticated host-contributed subject media
 *                      (host_source_v1/host_source, actorRole host).
 *   unknown          — historical provenance with no supporting evidence.
 *                      Stays unknown until recorded evidence exists.
 *
 * Delivery permission (serve an existing approved seed) NEVER implies
 * generation permission (derive new portrait media from a subject photo).
 * Only guest_mobile provenance can ever grant generation, and only when the
 * full eligibility binding holds. Budget flags, existing jobs, host role
 * alone, and legacy markers never grant generation.
 *
 * provenance/v1 delivery records are generation-only building blocks plus a
 * standalone delivery-approval check: the production seed-delivery gate is
 * contracts.evaluateDeliveryProvenance, which requires the same explicit
 * approval evidence (operatorApproved/approved or the persisted host
 * seed binding with host-device evidence). A stamped legacy_seed record
 * with deliveryApproved=false is refused by both gates.
 */

export const PROVENANCE_VERSION = "provenance/v1" as const;

export type ProvenanceOrigin =
  | "legacy_seed"
  | "operator_approval"
  | "host_approval"
  | "guest_mobile"
  | "host_source"
  | "unknown";

export type ProvenanceActorRole = "tv" | "host" | "guest" | "operator" | "system";

export interface ProvenanceRecord {
  /** Schema version marker; always PROVENANCE_VERSION. */
  version: typeof PROVENANCE_VERSION;
  origin: ProvenanceOrigin;
  /** Server-verified actor role. Never a client-supplied role string. */
  actorRole: ProvenanceActorRole;
  /** Server-verified device that produced the evidence, when applicable. */
  actorDeviceId?: string;
  /**
   * Where the evidence came from. Server-derived records use a "server:*"
   * source (e.g. "server:guest_upload", "server:host_invite",
   * "server:seed_catalog", "server:operator_tool"). Anything else is treated
   * as self-asserted and rejected for stronger origins.
   */
  evidenceSource: string;
  /** ISO timestamp when the server recorded this provenance. */
  recordedAt: string;
  partyId: string;
  channelId?: string;
  /** Permitted purposes. Preserves the existing consent text/purpose
   *  namespaces: "v1:guest_cameo" and "host_source_v1:host_source". */
  purposes: string[];
  /** SHA-256 of the consented source photo (generation binding). */
  sourceHash?: string;
  /** SHA-256 of an approved artifact (delivery binding). */
  artifactHash?: string;
  /** Revision marker binding this record to the underlying evidence
   *  (consent revision, seed version, approval id). */
  revision: string;
  /** ISO expiry when the grant lapses; absent means no expiry recorded. */
  expiresAt?: string;
  withdrawn?: boolean;
  withdrawnAt?: string;
  /**
   * Explicit delivery approval for legacy/operator/host origins. Absent or
   * false means delivery is NOT approved. This flag NEVER grants generation.
   */
  deliveryApproved?: boolean;
}

export interface ProvenanceScope {
  partyId: string;
  channelId?: string;
  deviceId?: string;
  nowMs: number;
}

/** Generation-permission inputs that MUST NOT grant generation. Accepted so
 *  callers can pass ambient state; every field is explicitly ignored. */
export interface GenerationAmbientFlags {
  budgetActive?: boolean;
  hasJob?: boolean;
  callerRole?: string;
  legacyMarker?: boolean;
}

const ORIGINS: readonly ProvenanceOrigin[] = [
  "legacy_seed",
  "operator_approval",
  "host_approval",
  "guest_mobile",
  "host_source",
  "unknown",
];

export function isProvenanceOrigin(value: unknown): value is ProvenanceOrigin {
  return typeof value === "string" && (ORIGINS as readonly string[]).includes(value);
}

/** Rank for self-assertion checks: generation-capable guest_mobile outranks
 *  approval/delivery origins; unknown is weakest. */
function originRank(origin: ProvenanceOrigin): number {
  switch (origin) {
    case "unknown": return 0;
    case "legacy_seed": return 1;
    case "host_approval": return 2;
    case "operator_approval": return 3;
    case "guest_mobile": return 4;
    case "host_source": return 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Validates a provenance record shape. Throws INVALID_ARGUMENT on any defect. */
export function validateProvenanceRecord(record: unknown): asserts record is ProvenanceRecord {
  if (!isRecord(record)) throw new BackendError("INVALID_ARGUMENT", "Provenance record must be an object.");
  if (record.version !== PROVENANCE_VERSION) throw new BackendError("INVALID_ARGUMENT", "Provenance version is unsupported.");
  if (!isProvenanceOrigin(record.origin)) throw new BackendError("INVALID_ARGUMENT", "Provenance origin is unknown.");
  if (!["tv", "host", "guest", "operator", "system"].includes(String(record.actorRole))) {
    throw new BackendError("INVALID_ARGUMENT", "Provenance actor role is invalid.");
  }
  if (record.actorDeviceId !== undefined && typeof record.actorDeviceId !== "string") {
    throw new BackendError("INVALID_ARGUMENT", "Provenance actor device is invalid.");
  }
  if (typeof record.evidenceSource !== "string" || record.evidenceSource.trim() === "") {
    throw new BackendError("INVALID_ARGUMENT", "Provenance evidence source is required.");
  }
  if (!isIsoDate(record.recordedAt)) throw new BackendError("INVALID_ARGUMENT", "Provenance timestamp is invalid.");
  if (typeof record.partyId !== "string" || !record.partyId) throw new BackendError("INVALID_ARGUMENT", "Provenance party scope is required.");
  if (record.channelId !== undefined && typeof record.channelId !== "string") {
    throw new BackendError("INVALID_ARGUMENT", "Provenance channel scope is invalid.");
  }
  if (!Array.isArray(record.purposes) || record.purposes.some((p) => typeof p !== "string")) {
    throw new BackendError("INVALID_ARGUMENT", "Provenance purposes must be strings.");
  }
  if (record.sourceHash !== undefined && !isSha256(record.sourceHash)) {
    throw new BackendError("INVALID_ARGUMENT", "Provenance source hash is invalid.");
  }
  if (record.artifactHash !== undefined && !isSha256(record.artifactHash)) {
    throw new BackendError("INVALID_ARGUMENT", "Provenance artifact hash is invalid.");
  }
  if (typeof record.revision !== "string" || !record.revision) throw new BackendError("INVALID_ARGUMENT", "Provenance revision is required.");
  if (record.expiresAt !== undefined && !isIsoDate(record.expiresAt)) {
    throw new BackendError("INVALID_ARGUMENT", "Provenance expiry is invalid.");
  }
  if (record.withdrawnAt !== undefined && !isIsoDate(record.withdrawnAt)) {
    throw new BackendError("INVALID_ARGUMENT", "Provenance withdrawal timestamp is invalid.");
  }
}

function scopeMatches(record: ProvenanceRecord, scope: ProvenanceScope): boolean {
  if (record.partyId !== scope.partyId) return false;
  // A channel-scoped grant never matches a channel-less (or different)
  // scope: when the record binds a channel, the scope must carry the same
  // channel, otherwise a channel-scoped grant would match a channel-less
  // request.
  if (record.channelId !== undefined && record.channelId !== scope.channelId) return false;
  return true;
}

function expiredOrWithdrawn(record: ProvenanceRecord, nowMs: number): boolean {
  if (record.withdrawn === true) return true;
  if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= nowMs) return true;
  return false;
}

function purposeKey(textVersion: string, purpose: string): string {
  return `${textVersion}:${purpose}`;
}

export const GUEST_MOBILE_PURPOSE = purposeKey(GUEST_CONSENT_TEXT_VERSION, GUEST_CONSENT_PURPOSE);
export const HOST_SOURCE_PURPOSE = purposeKey(HOST_SOURCE_CONSENT_TEXT_VERSION, HOST_SOURCE_CONSENT_PURPOSE);

/**
 * Delivery gate: may an existing approved seed artifact be served?
 * Pure function over plain data — safe to call with transaction-snapshot
 * reads from p2/p4 paths. Fail-closed boolean: malformed records, scope
 * mismatches, expiry, and withdrawal all return false (never throw).
 */
export function canDeliverSeedArtifact(record: ProvenanceRecord | undefined, scope: ProvenanceScope): boolean {
  if (!record) return false;
  try {
    validateProvenanceRecord(record);
  } catch {
    return false;
  }
  if (record.origin !== "legacy_seed" && record.origin !== "operator_approval" && record.origin !== "host_approval") {
    return false;
  }
  if (record.deliveryApproved !== true) return false;
  if (!scopeMatches(record, scope)) return false;
  if (expiredOrWithdrawn(record, scope.nowMs)) return false;
  return true;
}

/**
 * Generation gate: may NEW portrait-derived media be generated?
 * ONLY guest_mobile provenance ever returns true, and only with the full
 * server-verified binding (supported consent namespace, matching scope +
 * device, verified source hash, live grant). Budget flags, existing jobs,
 * host role alone, and legacy markers are accepted as ambient input and
 * EXPLICITLY IGNORED — they never grant generation.
 * Pure function over plain data for transaction-snapshot use by p2/p4.
 * Fail-closed boolean: malformed records return false (never throw).
 */
export function canGenerateFromPortrait(
  record: ProvenanceRecord | undefined,
  scope: ProvenanceScope,
  _ambient?: GenerationAmbientFlags,
): boolean {
  if (!record) return false;
  try {
    validateProvenanceRecord(record);
  } catch {
    return false;
  }
  if (record.origin !== "guest_mobile") return false;
  if (!scopeMatches(record, scope)) return false;
  if (expiredOrWithdrawn(record, scope.nowMs)) return false;
  // Consent namespace: exactly the preserved pairs, never mixed, never unknown.
  const hasGuestPair = record.purposes.includes(GUEST_MOBILE_PURPOSE);
  const hasHostPair = record.purposes.includes(HOST_SOURCE_PURPOSE);
  if (hasGuestPair === hasHostPair) return false;
  // Role/pair consistency: guest pair requires guest actor, host pair a host actor.
  if (hasGuestPair && record.actorRole !== "guest") return false;
  if (hasHostPair && record.actorRole !== "host") return false;
  // Device binding: the scope device must equal the verified actor device.
  if (typeof record.actorDeviceId !== "string" || scope.deviceId !== record.actorDeviceId) return false;
  if (!isSha256(record.sourceHash)) return false;
  if (typeof record.revision !== "string" || !record.revision) return false;
  // Evidence must be server-derived; client-asserted guest_mobile never grants.
  if (!record.evidenceSource.startsWith("server:")) return false;
  return true;
}

/** Throwing delivery gate for authenticated server paths. */
export function assertCanDeliverSeedArtifact(record: ProvenanceRecord | undefined, scope: ProvenanceScope): void {
  if (!canDeliverSeedArtifact(record, scope)) {
    throw new BackendError("FORBIDDEN", "Seed artifact delivery is not approved for this scope.");
  }
}

/** Throwing generation gate for authenticated server paths. */
export function assertCanGenerateFromPortrait(
  record: ProvenanceRecord | undefined,
  scope: ProvenanceScope,
  ambient?: GenerationAmbientFlags,
): void {
  if (!canGenerateFromPortrait(record, scope, ambient)) {
    throw new BackendError("FORBIDDEN", "Portrait-derived generation is not consented for this scope.");
  }
}

/**
 * Derives guest_mobile provenance from a server-read guestMedia document.
 * Returns undefined when the document carries no accepted supported consent
 * (caller treats that as no generation permission — never fabricates one).
 * Preserves the existing consent text/purpose namespaces verbatim.
 */
export function provenanceFromGuestMediaDoc(
  doc: Record<string, unknown>,
  evidenceSource: string,
  recordedAtIso: string,
): ProvenanceRecord | undefined {
  const consent = doc.consent as Record<string, unknown> | undefined;
  if (!isRecord(consent) || consent.accepted !== true) return undefined;
  const textVersion = String(consent.textVersion ?? "");
  const purpose = String(consent.purpose ?? "");
  const key = purposeKey(textVersion, purpose);
  if (key !== GUEST_MOBILE_PURPOSE && key !== HOST_SOURCE_PURPOSE) return undefined;
  const actorRole: ProvenanceActorRole = key === HOST_SOURCE_PURPOSE ? "host" : "guest";
  const sourceHash = typeof doc.sourceHash === "string" ? doc.sourceHash : undefined;
  return {
    version: PROVENANCE_VERSION,
    origin: key === HOST_SOURCE_PURPOSE ? "host_source" : "guest_mobile",
    actorRole,
    actorDeviceId: typeof doc.deviceId === "string" ? doc.deviceId : undefined,
    evidenceSource,
    recordedAt: recordedAtIso,
    partyId: String(doc.partyId ?? ""),
    channelId: typeof doc.channelId === "string" ? doc.channelId : undefined,
    purposes: [key],
    ...(sourceHash !== undefined ? { sourceHash } : {}),
    revision: typeof doc.consentRevision === "string" ? doc.consentRevision : key,
    ...(typeof doc.expiresAt === "string" ? { expiresAt: doc.expiresAt } : {}),
    ...(doc.status === "withdrawn" || doc.tombstone === true
      ? { withdrawn: true as const, ...(typeof doc.withdrawnAt === "string" ? { withdrawnAt: doc.withdrawnAt } : {}) }
      : {}),
  };
}

/**
 * Derives legacy_seed provenance from a server-read seed-catalog entry.
 * deliveryApproved MUST be passed explicitly from recorded approval evidence
 * (operator/host approval doc); it defaults to false and is never inferred
 * from the mere existence of the seed. Never carries guest acceptance.
 */
export function provenanceFromSeedEntry(
  seed: Record<string, unknown>,
  opts: { deliveryApproved: boolean; evidenceSource: string; recordedAtIso: string },
): ProvenanceRecord {
  return {
    version: PROVENANCE_VERSION,
    origin: "legacy_seed",
    actorRole: "system",
    evidenceSource: opts.evidenceSource,
    recordedAt: opts.recordedAtIso,
    partyId: String(seed.partyId ?? ""),
    channelId: typeof seed.channelId === "string" ? seed.channelId : undefined,
    purposes: ["seed_delivery"],
    revision: typeof seed.seedId === "string" ? `seed:${seed.seedId}` : "seed:unknown",
    ...(typeof seed.expiresAt === "string" ? { expiresAt: seed.expiresAt } : {}),
    ...(seed.status === "deleted" ? { withdrawn: true as const } : {}),
    deliveryApproved: opts.deliveryApproved,
  };
}

/** Records explicit operator approval provenance (server tool path only). */
export function provenanceFromOperatorApproval(input: {
  partyId: string;
  channelId?: string;
  artifactHash?: string;
  revision: string;
  recordedAtIso: string;
  expiresAt?: string;
  deliveryApproved: boolean;
}): ProvenanceRecord {
  return {
    version: PROVENANCE_VERSION,
    origin: "operator_approval",
    actorRole: "operator",
    evidenceSource: "server:operator_tool",
    recordedAt: input.recordedAtIso,
    partyId: input.partyId,
    ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
    purposes: ["seed_delivery"],
    ...(input.artifactHash !== undefined ? { artifactHash: input.artifactHash } : {}),
    revision: input.revision,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    deliveryApproved: input.deliveryApproved,
  };
}

/** Records explicit host approval provenance (registered-host server path only). */
export function provenanceFromHostApproval(input: {
  partyId: string;
  channelId?: string;
  hostDeviceId: string;
  revision: string;
  recordedAtIso: string;
  expiresAt?: string;
  deliveryApproved: boolean;
}): ProvenanceRecord {
  return {
    version: PROVENANCE_VERSION,
    origin: "host_approval",
    actorRole: "host",
    actorDeviceId: input.hostDeviceId,
    evidenceSource: "server:host_approval",
    recordedAt: input.recordedAtIso,
    partyId: input.partyId,
    ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
    purposes: ["seed_delivery"],
    revision: input.revision,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    deliveryApproved: input.deliveryApproved,
  };
}

/** Explicit unknown provenance: no supporting evidence. Never grants anything. */
export function provenanceUnknown(partyId: string, channelId: string | undefined, revision: string, recordedAtIso: string): ProvenanceRecord {
  return {
    version: PROVENANCE_VERSION,
    origin: "unknown",
    actorRole: "system",
    evidenceSource: "server:migration",
    recordedAt: recordedAtIso,
    partyId,
    ...(channelId !== undefined ? { channelId } : {}),
    purposes: [],
    revision,
  };
}

/**
 * Rejects attempts to self-assert a stronger origin. New provenance must be
 * derived from authenticated server paths: any record whose evidence source
 * is not "server:*" and whose origin outranks "unknown" is rejected, as is
 * any escalation beyond what the evidence source permits.
 */
export function assertServerDerived(record: ProvenanceRecord): void {
  validateProvenanceRecord(record);
  if (record.origin !== "unknown" && !record.evidenceSource.startsWith("server:")) {
    throw new BackendError("FORBIDDEN", "Provenance origin must be derived from an authenticated server path.");
  }
}

/** Escalation guard: a proposed record may not outrank the evidenced origin
 *  unless the evidence source is a server path. */
export function assertNoSelfAssertedEscalation(existing: ProvenanceRecord | undefined, proposed: ProvenanceRecord): void {
  validateProvenanceRecord(proposed);
  if (existing) validateProvenanceRecord(existing);
  assertServerDerived(proposed);
  const base = existing ? originRank(existing.origin) : 0;
  if (originRank(proposed.origin) > base && !proposed.evidenceSource.startsWith("server:")) {
    throw new BackendError("FORBIDDEN", "Provenance escalation requires server-verified evidence.");
  }
}

/** Marks a provenance record withdrawn while preserving the original
 *  evidence (revision, hashes, purposes, actor). Never mutates in place. */
export function markProvenanceWithdrawn(record: ProvenanceRecord, withdrawnAtIso: string): ProvenanceRecord {
  validateProvenanceRecord(record);
  if (!isIsoDate(withdrawnAtIso)) throw new BackendError("INVALID_ARGUMENT", "Withdrawal timestamp is invalid.");
  return { ...record, withdrawn: true, withdrawnAt: withdrawnAtIso };
}
