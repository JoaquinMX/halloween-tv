import { Firestore } from "firebase-admin/firestore";
import { BackendError, Identity, isSupportedConsent } from "./contracts";
import {
  GUEST_CONSENT_TEXT_VERSION,
} from "./config";
import {
  GUEST_MOBILE_PURPOSE,
  HOST_SOURCE_PURPOSE,
  ProvenanceRecord,
  provenanceFromGuestMediaDoc,
} from "./consent_provenance";

export const GUEST_MEDIA_COLLECTION = "guestMedia";

export type GuestMediaStatus = "pending_upload" | "eligible" | "withdrawn" | "expired";

export interface GuestConsentRecord {
  accepted: boolean;
  textVersion: string;
  purpose: string;
  acceptedAt: string;
  deviceId: string;
}

export interface GuestMediaDoc {
  submissionId: string;
  partyId: string;
  deviceId: string;
  channelId: string;
  status: GuestMediaStatus;
  consent: GuestConsentRecord;
  consentRevision: string;
  objectPath: string;
  contentType: string;
  expiresAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  sourceHash?: string;
  sourceSizeBytes?: number;
  sourceGeneration?: string | null;
  completedAt?: unknown;
  withdrawnAt?: unknown;
  tombstone?: boolean;
}

const OBJECT_RE = /^parties\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/guests\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/ingest\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/photo\.jpg$/;

export function guestObjectPath(partyId: string, deviceId: string, submissionId: string): string {
  return `parties/${partyId}/guests/${deviceId}/ingest/${submissionId}/photo.jpg`;
}

export function parseGuestObjectPath(objectPath: string): { partyId: string; deviceId: string; submissionId: string } | undefined {
  const match = OBJECT_RE.exec(objectPath);
  if (!match) return undefined;
  return { partyId: match[1], deviceId: match[2], submissionId: match[3] };
}

export function guestMediaRef(db: Firestore, partyId: string, submissionId: string) {
  return db.doc(`parties/${partyId}/${GUEST_MEDIA_COLLECTION}/${submissionId}`);
}

export function consentRevisionFor(acceptedAtIso: string): string {
  return `${GUEST_CONSENT_TEXT_VERSION}:${acceptedAtIso}`;
}

function expiryMs(value: unknown): number | undefined {
  if (value && typeof value === "object" && "toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Consent-bound eligibility gate shared by request, worker-submission, and
 * transactional publication paths. Throws FORBIDDEN when consent was
 * withdrawn or the binding does not match the caller, CLIP_EXPIRED when the
 * input window lapsed, NOT_FOUND for unknown submissions.
 */
export async function assertGuestEligible(
  db: Firestore,
  identity: Identity,
  submissionId: string,
  nowMs: number,
): Promise<GuestMediaDoc> {
  const snapshot = await guestMediaRef(db, identity.partyId, submissionId).get();
  if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Guest media does not exist.");
  const doc = snapshot.data() as GuestMediaDoc;
  if (
    doc.partyId !== identity.partyId ||
    doc.deviceId !== identity.deviceId ||
    doc.channelId !== identity.channelId ||
    doc.submissionId !== submissionId
  ) {
    throw new BackendError("FORBIDDEN", "Guest media is not bound to this party, device, and channel.");
  }
  if (doc.status === "withdrawn") throw new BackendError("FORBIDDEN", "Guest consent was withdrawn.");
  if (doc.status === "expired") throw new BackendError("CLIP_EXPIRED", "Guest media has expired.");
  if (doc.status !== "eligible") throw new BackendError("FORBIDDEN", "Guest media is not eligible for generation.");
  if (!doc.consent || doc.consent.accepted !== true ||
      !isSupportedConsent(doc.consent.textVersion, doc.consent.purpose) ||
      doc.consent.deviceId !== identity.deviceId) {
    throw new BackendError("FORBIDDEN", "Guest consent is not recorded for this device.");
  }
  const expiry = expiryMs(doc.expiresAt);
  if (expiry === undefined || expiry <= nowMs) throw new BackendError("CLIP_EXPIRED", "Guest media has expired.");
  if (typeof doc.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(doc.sourceHash) ||
      !Number.isSafeInteger(doc.sourceSizeBytes) || Number(doc.sourceSizeBytes) <= 0) {
    throw new BackendError("FORBIDDEN", "Guest media source is not verified.");
  }
  return doc;
}

/** Reads the guest doc for job binding without requiring eligibility (worker cleanup paths). */
export async function readGuestMediaDoc(
  db: Firestore,
  partyId: string,
  submissionId: string,
): Promise<GuestMediaDoc | undefined> {
  const snapshot = await guestMediaRef(db, partyId, submissionId).get();
  if (!snapshot.exists) return undefined;
  return snapshot.data() as GuestMediaDoc;
}

/**
 * Derives versioned guest_mobile provenance from a server-read guestMedia
 * document. Pure read of recorded evidence: returns undefined when the doc
 * carries no accepted supported consent (never fabricates acceptance).
 * Usable with transaction-snapshot reads from p2/p4 paths.
 */
export function guestProvenanceFromDoc(
  doc: GuestMediaDoc,
  evidenceSource = "server:guest_upload",
): ProvenanceRecord | undefined {
  const recordedAt = typeof doc.consent?.acceptedAt === "string" && Number.isFinite(Date.parse(doc.consent.acceptedAt))
    ? doc.consent.acceptedAt
    : new Date().toISOString();
  return provenanceFromGuestMediaDoc(doc as unknown as Record<string, unknown>, evidenceSource, recordedAt);
}

/**
 * Derivative object paths attributable to a generation job. Covers staged
 * camera outputs, delivery + generated paths, cartoon stills, intermediate
 * outputs, and delivery objects recorded under current or historical field
 * names. Audit/accounting fields (costLogs, usage rows) are never paths and
 * are never included. Shared catalog references are NOT resolved here; the
 * retention sweeper protects objects still referenced by live seeds/jobs.
 */
export function collectJobDerivativePaths(job: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  const addList = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.startsWith("parties/")) paths.add(item);
      }
    }
  };
  for (const key of [
    "deliveryPaths",
    "generatedPaths",
    "stillPaths",
    "intermediatePaths",
    "previewPaths",
    "deliveryObjects",
    "stagedPaths",
  ] as const) {
    addList(job[key]);
  }
  for (const key of ["cartoonStillPath", "stillPath", "intermediatePath"] as const) {
    const single = job[key];
    if (typeof single === "string" && single.startsWith("parties/")) paths.add(single);
  }
  const staged = job.stagedOutputs;
  if (staged && typeof staged === "object") {
    for (const clip of Object.values(staged as Record<string, unknown>)) {
      if (clip && typeof clip === "object" && typeof (clip as Record<string, unknown>).objectPath === "string") {
        const path = (clip as Record<string, unknown>).objectPath as string;
        if (path.startsWith("parties/")) paths.add(path);
      }
    }
  }
  // Cartoon still generated from the consent-bound portrait. Persisted nested
  // at job.cartoonChain.stillPath (parties/*/cartoonStills/*/still.png); the
  // top-level keys above never reach it, so it is traversed explicitly here.
  const chain = job.cartoonChain;
  if (chain && typeof chain === "object") {
    const record = chain as Record<string, unknown>;
    const still = record.stillPath;
    if (typeof still === "string" && still.startsWith("parties/")) paths.add(still);
    const stillList = record.stillPaths;
    if (Array.isArray(stillList)) {
      for (const item of stillList) {
        if (typeof item === "string" && item.startsWith("parties/")) paths.add(item);
      }
    }
  }
  return [...paths];
}

export { GUEST_MOBILE_PURPOSE, HOST_SOURCE_PURPOSE };
