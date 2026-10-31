import { Firestore } from "firebase-admin/firestore";
import { BackendError, Identity, isSupportedConsent } from "./contracts";
import {
  GUEST_CONSENT_TEXT_VERSION,
} from "./config";

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
