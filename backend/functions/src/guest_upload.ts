import { createHash, randomUUID } from "node:crypto";
import { Bucket, File } from "@google-cloud/storage";
import { FieldValue, Firestore, Timestamp } from "firebase-admin/firestore";
import { assertRegisteredPartyDevice } from "./auth";
import {
  GUEST_ALLOWED_CONTENT_TYPES,
  GUEST_CONSENT_PURPOSE,
  GUEST_CONSENT_TEXT_VERSION,
  GUEST_INPUT_TTL_MS,
  GUEST_MAX_IMAGE_BYTES,
  GUEST_UPLOAD_TTL_MS,
} from "./config";
import { BackendError, requireIdentity, validateId } from "./contracts";
import {
  consentRevisionFor,
  GuestMediaDoc,
  guestMediaRef,
  guestObjectPath,
  parseGuestObjectPath,
} from "./guest_media";

export interface GuestUploadServiceOptions {
  db: Firestore;
  bucket: Bucket;
  now?: () => Date;
  /** Emulator-injected PUT signer. Production uses v4 signed PUT URLs. */
  signUploadUrl?: (file: File, contentType: string, expiresAt: Date) => Promise<string>;
  deleteObject?: (file: File) => Promise<void>;
}

export interface RequestGuestUploadResult {
  submissionId: string;
  objectPath: string;
  uploadUrl: string;
  expiresAt: string;
  consentRevision: string;
}

export interface GuestMediaStatusResult {
  submissionId: string;
  partyId: string;
  deviceId: string;
  channelId: string;
  status: GuestMediaDoc["status"];
  objectPath: string;
  consentRevision: string;
  expiresAt: string;
  sha256?: string;
  sizeBytes?: number;
}

export interface WithdrawGuestMediaResult {
  submissionId: string;
  status: "withdrawn";
  deletedObjects: string[];
  verifiedAbsent: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function newSubmissionId(): string {
  return `gsub-${randomUUID().replace(/-/g, "")}`;
}

function expiryIso(value: unknown): string {
  if (value && typeof value === "object" && "toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  throw new BackendError("INTERNAL", "Guest media expiry is missing.");
}

function looksLikeImage(bytes: Buffer): boolean {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  return false;
}

async function deleteWithRetry(deleteObject: (file: File) => Promise<void>, file: File, attempts = 3): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await deleteObject(file);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Guest object deletion failed.");
}

export function createGuestUploadService(options: GuestUploadServiceOptions) {
  const { db, bucket } = options;
  const now = options.now ?? (() => new Date());
  const signUploadUrl = options.signUploadUrl ?? (async (file, contentType, expiresAt) => {
    const [url] = await file.getSignedUrl({ action: "write", version: "v4", expires: expiresAt, contentType });
    return url;
  });
  const deleteObject = options.deleteObject ?? (async (file) => {
    await file.delete({ ignoreNotFound: true });
  });

  async function requestGuestUpload(value: unknown): Promise<RequestGuestUploadResult> {
    const identity = requireIdentity(value);
    if (!identity.channelId) throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
    if (!isRecord(value)) throw new BackendError("INVALID_ARGUMENT", "Guest upload payload must be an object.");
    if ("objectPath" in value || "submissionId" in value || "uploadUrl" in value) {
      throw new BackendError("INVALID_ARGUMENT", "Upload paths are assigned by the server.");
    }
    const consent = value.consent;
    if (!isRecord(consent) || consent.accepted !== true) {
      throw new BackendError("FORBIDDEN", "Affirmative guest consent is required before upload.");
    }
    if (consent.textVersion !== GUEST_CONSENT_TEXT_VERSION || consent.purpose !== GUEST_CONSENT_PURPOSE) {
      throw new BackendError("INVALID_ARGUMENT", "Guest consent version or purpose is unsupported.");
    }
    const contentType = value.contentType;
    if (typeof contentType !== "string" ||
        !(GUEST_ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      throw new BackendError("INVALID_ARGUMENT", "Only JPEG or PNG guest photos are supported.");
    }
    await assertRegisteredPartyDevice(db, identity);
    const submissionId = newSubmissionId();
    validateId(submissionId, "submissionId");
    const objectPath = guestObjectPath(identity.partyId, identity.deviceId, submissionId);
    const acceptedAt = now();
    const acceptedAtIso = acceptedAt.toISOString();
    const consentRevision = consentRevisionFor(acceptedAtIso);
    const expiresAt = new Date(acceptedAt.getTime() + GUEST_UPLOAD_TTL_MS);
    const ref = guestMediaRef(db, identity.partyId, submissionId);
    await ref.create({
      submissionId,
      partyId: identity.partyId,
      deviceId: identity.deviceId,
      channelId: identity.channelId,
      status: "pending_upload",
      consent: {
        accepted: true,
        textVersion: GUEST_CONSENT_TEXT_VERSION,
        purpose: GUEST_CONSENT_PURPOSE,
        acceptedAt: acceptedAtIso,
        deviceId: identity.deviceId,
      },
      consentRevision,
      objectPath,
      contentType,
      expiresAt: Timestamp.fromDate(expiresAt),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    // The signed PUT capability is returned, never persisted in Firestore or logs.
    const uploadUrl = await signUploadUrl(bucket.file(objectPath), contentType, expiresAt);
    return { submissionId, objectPath, uploadUrl, expiresAt: expiresAt.toISOString(), consentRevision };
  }

  async function completeGuestUpload(value: unknown): Promise<GuestMediaStatusResult> {
    if (!isRecord(value)) throw new BackendError("INVALID_ARGUMENT", "Completion payload must be an object.");
    const identity = requireIdentity(value);
    if (!identity.channelId) throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
    if (typeof value.submissionId !== "string" || !value.submissionId) {
      throw new BackendError("INVALID_ARGUMENT", "submissionId is required.");
    }
    const submissionId = validateId(value.submissionId, "submissionId");
    await assertRegisteredPartyDevice(db, identity);
    const ref = guestMediaRef(db, identity.partyId, submissionId);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Guest media does not exist.");
    const doc = snapshot.data() as GuestMediaDoc;
    if (doc.partyId !== identity.partyId || doc.deviceId !== identity.deviceId || doc.channelId !== identity.channelId) {
      throw new BackendError("FORBIDDEN", "Guest media is not bound to this party, device, and channel.");
    }
    if (doc.status === "withdrawn") throw new BackendError("FORBIDDEN", "Guest consent was withdrawn.");
    const expiryMs = doc.expiresAt instanceof Timestamp ? doc.expiresAt.toDate().getTime() : Date.parse(String(doc.expiresAt));
    if (!Number.isFinite(expiryMs) || expiryMs <= now().getTime()) {
      if (doc.status !== "expired") {
        await ref.update({ status: "expired", updatedAt: FieldValue.serverTimestamp() });
      }
      throw new BackendError("CLIP_EXPIRED", "Guest upload capability has expired.");
    }
    const expectedPath = guestObjectPath(identity.partyId, identity.deviceId, submissionId);
    if (doc.objectPath !== expectedPath) {
      throw new BackendError("MANIFEST_MISMATCH", "Guest object binding is invalid.");
    }
    const file = bucket.file(expectedPath);
    const [exists] = await file.exists();
    if (!exists) throw new BackendError("NOT_FOUND", "Guest photo bytes are not present.");
    const [bytes] = await file.download();
    if (bytes.byteLength <= 0 || bytes.byteLength > GUEST_MAX_IMAGE_BYTES) {
      throw new BackendError("INVALID_ARGUMENT", "Guest photo size is outside the supported range.");
    }
    if (!looksLikeImage(bytes)) {
      throw new BackendError("INVALID_ARGUMENT", "Guest upload is not a JPEG or PNG image.");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (doc.status === "eligible") {
      if (doc.sourceHash !== sha256 || doc.sourceSizeBytes !== bytes.byteLength) {
        throw new BackendError("MANIFEST_MISMATCH", "Guest object changed after eligibility was recorded.");
      }
      return {
        submissionId,
        partyId: doc.partyId,
        deviceId: doc.deviceId,
        channelId: doc.channelId,
        status: "eligible",
        objectPath: doc.objectPath,
        consentRevision: doc.consentRevision,
        expiresAt: expiryIso(doc.expiresAt),
        sha256,
        sizeBytes: bytes.byteLength,
      };
    }
    let generation: string | null = null;
    try {
      const [metadata] = await file.getMetadata();
      if (metadata && typeof metadata.generation === "string") generation = metadata.generation;
    } catch {
      generation = null;
    }
    const eligibleExpiresAt = new Date(now().getTime() + GUEST_INPUT_TTL_MS);
    await ref.update({
      status: "eligible",
      sourceHash: sha256,
      sourceSizeBytes: bytes.byteLength,
      sourceGeneration: generation,
      completedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromDate(eligibleExpiresAt),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      submissionId,
      partyId: identity.partyId,
      deviceId: identity.deviceId,
      channelId: identity.channelId,
      status: "eligible",
      objectPath: expectedPath,
      consentRevision: doc.consentRevision,
      expiresAt: eligibleExpiresAt.toISOString(),
      sha256,
      sizeBytes: bytes.byteLength,
    };
  }

  async function getGuestMediaStatus(value: unknown): Promise<GuestMediaStatusResult> {
    if (!isRecord(value)) throw new BackendError("INVALID_ARGUMENT", "Status payload must be an object.");
    const identity = requireIdentity(value);
    if (!identity.channelId) throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
    if (typeof value.submissionId !== "string" || !value.submissionId) {
      throw new BackendError("INVALID_ARGUMENT", "submissionId is required.");
    }
    const submissionId = validateId(value.submissionId, "submissionId");
    await assertRegisteredPartyDevice(db, identity);
    const snapshot = await guestMediaRef(db, identity.partyId, submissionId).get();
    if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Guest media does not exist.");
    const doc = snapshot.data() as GuestMediaDoc;
    if (doc.partyId !== identity.partyId || doc.deviceId !== identity.deviceId || doc.channelId !== identity.channelId) {
      throw new BackendError("FORBIDDEN", "Guest media is not bound to this party, device, and channel.");
    }
    const result: GuestMediaStatusResult = {
      submissionId,
      partyId: doc.partyId,
      deviceId: doc.deviceId,
      channelId: doc.channelId,
      status: doc.status,
      objectPath: doc.objectPath,
      consentRevision: doc.consentRevision,
      expiresAt: expiryIso(doc.expiresAt),
    };
    if (typeof doc.sourceHash === "string") result.sha256 = doc.sourceHash;
    if (typeof doc.sourceSizeBytes === "number") result.sizeBytes = doc.sourceSizeBytes;
    return result;
  }

  async function withdrawGuestMedia(value: unknown): Promise<WithdrawGuestMediaResult> {
    if (!isRecord(value)) throw new BackendError("INVALID_ARGUMENT", "Withdrawal payload must be an object.");
    const identity = requireIdentity(value);
    if (!identity.channelId) throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
    if (typeof value.submissionId !== "string" || !value.submissionId) {
      throw new BackendError("INVALID_ARGUMENT", "submissionId is required.");
    }
    const submissionId = validateId(value.submissionId, "submissionId");
    await assertRegisteredPartyDevice(db, identity);
    const ref = guestMediaRef(db, identity.partyId, submissionId);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Guest media does not exist.");
    const doc = snapshot.data() as GuestMediaDoc;
    if (doc.partyId !== identity.partyId || doc.deviceId !== identity.deviceId || doc.channelId !== identity.channelId) {
      throw new BackendError("FORBIDDEN", "Guest media is not bound to this party, device, and channel.");
    }
    const objectPath = guestObjectPath(identity.partyId, identity.deviceId, submissionId);
    const withdrawnAt = now().toISOString();
    // Revoke eligibility first so concurrent submissions and publication fail closed.
    await ref.set({
      submissionId,
      partyId: identity.partyId,
      deviceId: identity.deviceId,
      channelId: identity.channelId,
      status: "withdrawn",
      consentRevision: doc.consentRevision,
      objectPath,
      contentType: doc.contentType,
      expiresAt: doc.expiresAt,
      createdAt: doc.createdAt,
      withdrawnAt,
      tombstone: true,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: false });
    // Discard attributable cloud derivatives and block running bound jobs.
    const deletedObjects: string[] = [];
    const jobs = await db.collection(`parties/${identity.partyId}/jobs`).where("guestMedia.submissionId", "==", submissionId).get();
    for (const jobDoc of jobs.docs) {
      const job = jobDoc.data();
      const staged = (job.stagedOutputs && typeof job.stagedOutputs === "object" ? job.stagedOutputs : {}) as Record<string, unknown>;
      for (const clip of Object.values(staged)) {
        if (clip && typeof clip === "object" && typeof (clip as Record<string, unknown>).objectPath === "string") {
          const path = (clip as Record<string, unknown>).objectPath as string;
          if (path.startsWith("parties/")) {
            try {
              await deleteWithRetry(deleteObject, bucket.file(path));
              deletedObjects.push(path);
            } catch {
              // Failed derivative deletes stay visible via the throw below only
              // for the source object; derivatives are retried by the sweeper.
            }
          }
        }
      }
      if (!["failed", "purged", "expired"].includes(String(job.state))) {
        await jobDoc.ref.update({
          state: "failed",
          status: "failed",
          errorCode: "FORBIDDEN",
          failedAt: FieldValue.serverTimestamp(),
          timestamp: FieldValue.serverTimestamp(),
          workerLeaseUntilMs: 0,
        });
      }
    }
    await deleteWithRetry(deleteObject, bucket.file(objectPath));
    deletedObjects.unshift(objectPath);
    const [stillExists] = await bucket.file(objectPath).exists();
    if (stillExists) throw new BackendError("INTERNAL", "Guest source object could not be removed.");
    return { submissionId, status: "withdrawn", deletedObjects, verifiedAbsent: true };
  }

  /**
   * Object-finalization cleanup: a PUT after withdrawal must not restore
   * eligibility and is deleted. Pending uploads are left alone; explicit
   * completion validates bytes before any eligibility change.
   */
  async function handleIngestFinalized(objectPath: string): Promise<{ handled: boolean; deleted: boolean }> {
    const parsed = parseGuestObjectPath(objectPath);
    if (!parsed) return { handled: false, deleted: false };
    const snapshot = await guestMediaRef(db, parsed.partyId, parsed.submissionId).get();
    if (!snapshot.exists) {
      await deleteWithRetry(deleteObject, bucket.file(objectPath));
      return { handled: true, deleted: true };
    }
    const doc = snapshot.data() as GuestMediaDoc;
    if (doc.deviceId !== parsed.deviceId || doc.partyId !== parsed.partyId) {
      await deleteWithRetry(deleteObject, bucket.file(objectPath));
      return { handled: true, deleted: true };
    }
    if (doc.status === "withdrawn" || doc.status === "expired") {
      await deleteWithRetry(deleteObject, bucket.file(objectPath));
      const [stillExists] = await bucket.file(objectPath).exists();
      if (stillExists) throw new BackendError("INTERNAL", "Withdrawn guest object could not be removed.");
      return { handled: true, deleted: true };
    }
    return { handled: true, deleted: false };
  }

  return { requestGuestUpload, completeGuestUpload, getGuestMediaStatus, withdrawGuestMedia, handleIngestFinalized };
}

export type GuestUploadServices = ReturnType<typeof createGuestUploadService>;
