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
import {
  BackendError, GenerationQueueState, PendingCartoonIntentPlan, isHostSourceConsent, isSupportedConsent, pendingCartoonIntentPath, requireIdentity, validateId,
} from "./contracts";
import { buildAutoCartoonPlan } from "./cartoon_pipeline";
import { loadValidatedCatalogs, resolveFunctionsRoot } from "./scenario_catalog";
import {
  consentRevisionFor,
  GuestMediaDoc,
  collectJobDerivativePaths,
  guestMediaRef,
  guestObjectPath,
  guestProvenanceFromDoc,
  parseGuestObjectPath,
} from "./guest_media";
import { markProvenanceWithdrawn, PROVENANCE_VERSION } from "./consent_provenance";

export interface GuestUploadServiceOptions {
  db: Firestore;
  bucket: Bucket;
  now?: () => Date;
  /** Emulator-injected PUT signer. Production uses v4 signed PUT URLs. */
  signUploadUrl?: (file: File, contentType: string, expiresAt: Date) => Promise<string>;
  deleteObject?: (file: File) => Promise<void>;
  /**
   * Portrait-eligible hook (cycle-13 fix-3 auto-enqueue + fix-5a durable
   * intent): invoked best-effort after a portrait becomes eligible
   * (completion) and when finalization observes an already-eligible portrait
   * (trigger/replay). Failures never break upload; BUDGET_EXCEEDED leaves the
   * durable pending intent for bounded server dispatch after capacity
   * releases, while queue-admission failures mark the intent TERMINAL
   * unavailable (surfaced via getGuestMediaStatus, never silent). Host-source
   * portraits are skipped here: the explicit host seed request owns that
   * scope's ONE job/plan. The enqueue path itself is idempotent (one
   * persisted plan, one job, no reroll/rebill).
   */
  onPortraitEligible?: (info: { partyId: string; deviceId: string; channelId: string; submissionId: string; hostSource: boolean }) => Promise<void>;
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
  /** Durable queue state (fix-5a): pending/queued/ready/failed/unavailable. Absent when no intent/job exists. */
  generation?: {
    state: GenerationQueueState;
    jobId?: string;
    errorCode?: string;
    plan?: PendingCartoonIntentPlan;
  };
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

function hardDeleteMs(doc: GuestMediaDoc, fallbackMs: number): number {
  const raw = (doc as unknown as Record<string, unknown>).deleteAt;
  if (raw && typeof raw === "object" && "toDate" in raw && typeof (raw as { toDate?: unknown }).toDate === "function") {
    const ms = (raw as { toDate: () => Date }).toDate().getTime();
    if (Number.isFinite(ms)) return ms;
  }
  if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw.getTime();
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallbackMs;
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
  const onPortraitEligible = options.onPortraitEligible;

  /** Best-effort auto-enqueue: never breaks the upload path. */
  async function notifyPortraitEligible(info: { partyId: string; deviceId: string; channelId: string; submissionId: string; hostSource: boolean }): Promise<void> {
    if (!onPortraitEligible) return;
    try {
      await onPortraitEligible(info);
    } catch (error) {
      // Upload stays fully operational when generation is disabled,
      // misconfigured, or the queue is unavailable. BUDGET_EXCEEDED keeps
      // the durable pending intent for bounded dispatch after capacity
      // releases; any other failure marks the intent TERMINAL unavailable
      // (visible via getGuestMediaStatus, never silent eligible-forever).
      if (error instanceof BackendError && error.errorCode === "BUDGET_EXCEEDED") return;
      const code = error instanceof BackendError ? error.errorCode : "PROVIDER_UNAVAILABLE";
      await db.doc(pendingCartoonIntentPath(info.partyId, info.submissionId)).update({
        status: "unavailable",
        errorCode: code,
        updatedAt: FieldValue.serverTimestamp(),
      }).catch(() => undefined);
      return;
    }
    // Successful dispatch (or idempotent reuse): reflect queued state
    // best-effort so status readers see progress without polling the queue.
    await db.doc(pendingCartoonIntentPath(info.partyId, info.submissionId)).update({
      status: "queued",
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => undefined);
  }

  /**
   * Durable pending-intent selection (fix-5a): the same deterministic
   * server selection as requestCartoonFromPortrait for the same portrait
   * (shared helper buildAutoCartoonPlan, never duplicated logic), so the
   * dispatched retry reuses the SAME immutable plan/version/seed (no reroll).
   */
  function planForSubmission(submissionId: string): PendingCartoonIntentPlan {
    const { catalog, situations } = loadValidatedCatalogs(resolveFunctionsRoot());
    const plan = buildAutoCartoonPlan({ submissionId, catalog, situations });
    return {
      scenarioId: plan.scenarioId,
      situationId: plan.situationId,
      portraitSubmissionId: submissionId,
      stillPlanId: plan.stillPlanId,
      videoPlanId: plan.videoPlanId,
      version: plan.version,
      seed: plan.seed,
    };
  }

  function plansEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }

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
    // Consent namespace: guest devices use v1/guest_cameo; host devices use
    // the distinct host_source_v1/host_source pair (with an attestation copy
    // stored below). Either pair is a supported consent version/purpose, but
    // the pairs never mix across roles.
    if (!isSupportedConsent(consent.textVersion, consent.purpose)) {
      throw new BackendError("INVALID_ARGUMENT", "Guest consent version or purpose is unsupported.");
    }
    const contentType = value.contentType;
    if (typeof contentType !== "string" ||
        !(GUEST_ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      throw new BackendError("INVALID_ARGUMENT", "Only JPEG or PNG guest photos are supported.");
    }
    const registered = await assertRegisteredPartyDevice(db, identity);
    const callerRole = String(registered.device.role ?? "guest");
    const hostCaller = callerRole === "host";
    if (hostCaller !== isHostSourceConsent(consent.textVersion, consent.purpose)) {
      throw new BackendError("INVALID_ARGUMENT", "Consent version or purpose does not match the caller role.");
    }
    const submissionId = newSubmissionId();
    validateId(submissionId, "submissionId");
    const objectPath = guestObjectPath(identity.partyId, identity.deviceId, submissionId);
    const acceptedAt = now();
    const acceptedAtIso = acceptedAt.toISOString();
    // Namespaced revision: host sources carry host_source_v1:…, guest
    // sources carry v1:… (via consentRevisionFor). The revision travels on
    // the job binding and is rechecked at eligibility time.
    const consentRevision = hostCaller
      ? `${String(consent.textVersion)}:${acceptedAtIso}`
      : consentRevisionFor(acceptedAtIso);
    const expiresAt = new Date(acceptedAt.getTime() + GUEST_UPLOAD_TTL_MS);
    // Immutable creation-based deletion deadline: completion may narrow the
    // visible expiry but must never extend retention past creation + 24h.
    const deleteAt = new Date(acceptedAt.getTime() + GUEST_INPUT_TTL_MS);
    const ref = guestMediaRef(db, identity.partyId, submissionId);
    // Server-derived role-specific provenance, stamped at the authenticated
    // request path (no source hash yet — bytes are unverified until
    // completion, so this record alone never grants generation).
    const requestProvenance = {
      version: PROVENANCE_VERSION,
      origin: hostCaller ? "host_source" : "guest_mobile",
      actorRole: hostCaller ? "host" : "guest",
      actorDeviceId: identity.deviceId,
      evidenceSource: "server:guest_upload",
      recordedAt: acceptedAtIso,
      partyId: identity.partyId,
      channelId: identity.channelId,
      purposes: [`${String(consent.textVersion)}:${String(consent.purpose)}`],
      revision: hostCaller
        ? `${String(consent.textVersion)}:${acceptedAtIso}`
        : consentRevisionFor(acceptedAtIso),
      expiresAt: expiresAt.toISOString(),
    } as const;
    await ref.create({
      submissionId,
      partyId: identity.partyId,
      deviceId: identity.deviceId,
      channelId: identity.channelId,
      status: "pending_upload",
      consent: {
        accepted: true,
        textVersion: String(consent.textVersion),
        purpose: String(consent.purpose),
        acceptedAt: acceptedAtIso,
        deviceId: identity.deviceId,
      },
      // Attestation copy: mirrors the consent text/purpose at acceptance so
      // later audits can distinguish host-originated sources from guest
      // cameo sources without re-reading the consent history.
      attestation: {
        textVersion: String(consent.textVersion),
        purpose: String(consent.purpose),
        acceptedAt: acceptedAtIso,
        deviceId: identity.deviceId,
        role: hostCaller ? "host" : "guest",
      },
      consentRevision,
      provenance: { ...requestProvenance },
      objectPath,
      contentType,
      expiresAt: Timestamp.fromDate(expiresAt),
      deleteAt: Timestamp.fromDate(deleteAt),
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
    // Size-first gate: enforce the 10MB cap from object metadata before
    // downloading any bytes, so an oversized PUT is rejected without a full
    // download. The post-download length check below stays as a backstop for
    // stores that report no size.
    try {
      const [metadata] = await file.getMetadata();
      const reported = Number((metadata as { size?: unknown } | undefined)?.size);
      if (Number.isFinite(reported) && (reported <= 0 || reported > GUEST_MAX_IMAGE_BYTES)) {
        throw new BackendError("INVALID_ARGUMENT", "Guest photo size is outside the supported range.");
      }
    } catch (error) {
      if (error instanceof BackendError) throw error;
    }
    const [bytes] = await file.download();
    if (bytes.byteLength <= 0 || bytes.byteLength > GUEST_MAX_IMAGE_BYTES) {
      throw new BackendError("INVALID_ARGUMENT", "Guest photo size is outside the supported range.");
    }
    if (!looksLikeImage(bytes)) {
      throw new BackendError("INVALID_ARGUMENT", "Guest upload is not a JPEG or PNG image.");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const hostSource = isHostSourceConsent(doc.consent?.textVersion, doc.consent?.purpose);
    if (doc.status === "eligible") {
      if (doc.sourceHash !== sha256 || doc.sourceSizeBytes !== bytes.byteLength) {
        throw new BackendError("MANIFEST_MISMATCH", "Guest object changed after eligibility was recorded.");
      }
      // Replay-safe: an already-eligible completion still triggers the
      // idempotent auto-enqueue exactly once downstream. Host-source
      // portraits skip the guest auto path (the explicit host seed request
      // owns that scope's ONE job/plan); the intent is ensured here for
      // guest portraits so a busy party persists pending intent.
      if (!hostSource && onPortraitEligible) {
        const replayPlan = (() => { try { return planForSubmission(submissionId); } catch { return undefined; } })();
        if (replayPlan) {
          const intentRef = db.doc(pendingCartoonIntentPath(identity.partyId, submissionId));
          await db.runTransaction(async (transaction) => {
            const [fresh, intentSnap] = await Promise.all([transaction.get(ref), transaction.get(intentRef)]);
            if (!fresh.exists) return;
            const current = fresh.data() as GuestMediaDoc;
            if (current.status !== "eligible") return;
            if ((current as GuestMediaDoc & { tombstone?: unknown }).tombstone === true || String(current.status) === "withdrawn") return;
            if (!intentSnap.exists) {
              transaction.create(intentRef, {
                partyId: identity.partyId,
                deviceId: identity.deviceId,
                channelId: identity.channelId,
                submissionId,
                consentRevision: current.consentRevision,
                sourceHash: sha256,
                plan: replayPlan,
                status: "pending",
                attempts: 0,
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
              });
            }
          }).catch(() => undefined);
        }
      }
      await notifyPortraitEligible({ partyId: identity.partyId, deviceId: identity.deviceId, channelId: identity.channelId, submissionId, hostSource });
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
    // Transactional commit against FRESH consent + status: a withdrawal that
    // lands between the checks above and this write fails closed instead of
    // producing eligible-on-tombstone. The immutable creation-based deadline
    // caps the visible expiry so completion never extends retention.
    const completionMs = now().getTime();
    const hardDeadline = hardDeleteMs(doc, completionMs + GUEST_INPUT_TTL_MS);
    const eligibleExpiresAt = new Date(Math.min(completionMs + GUEST_INPUT_TTL_MS, hardDeadline));
    // Durable pending intent (fix-5a): computed before the transaction from
    // the same deterministic selector (no reroll across retries). Created in
    // the same transaction as eligibility below; host-source portraits and
    // generation-disabled compositions never create one.
    const completionHostSource = isHostSourceConsent(doc.consent?.textVersion, doc.consent?.purpose);
    const completionPlan = (!completionHostSource && onPortraitEligible)
      ? (() => { try { return planForSubmission(submissionId); } catch { return undefined; } })()
      : undefined;
    const intentRef = db.doc(pendingCartoonIntentPath(identity.partyId, submissionId));
    try {
      await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(ref);
        if (!fresh.exists) throw new BackendError("NOT_FOUND", "Guest media does not exist.");
        const current = fresh.data() as GuestMediaDoc;
        // All transactional reads precede all writes (Firestore requires
        // reads-before-writes): the intent snapshot is read here, before the
        // eligibility update below.
        if (current.partyId !== identity.partyId || current.deviceId !== identity.deviceId || current.channelId !== identity.channelId) {
          throw new BackendError("FORBIDDEN", "Guest media is not bound to this party, device, and channel.");
        }
        // Withdrawal is irreversible: tombstone or withdrawn status fails the
        // completion even when the pre-transaction snapshot looked live.
        if ((current as GuestMediaDoc & { tombstone?: unknown }).tombstone === true || current.status === "withdrawn") {
          throw new BackendError("FORBIDDEN", "Guest consent was withdrawn.");
        }
        if (current.status === "expired") throw new BackendError("CLIP_EXPIRED", "Guest upload capability has expired.");
        const freshExpiryMs = current.expiresAt instanceof Timestamp
          ? current.expiresAt.toDate().getTime()
          : Date.parse(String(current.expiresAt));
        if (!Number.isFinite(freshExpiryMs) || freshExpiryMs <= completionMs) {
          transaction.update(ref, { status: "expired", updatedAt: FieldValue.serverTimestamp() });
          throw new BackendError("CLIP_EXPIRED", "Guest upload capability has expired.");
        }
        if (!current.consent || current.consent.accepted !== true ||
            !isSupportedConsent(current.consent.textVersion, current.consent.purpose) ||
            current.consent.deviceId !== identity.deviceId) {
          throw new BackendError("FORBIDDEN", "Guest consent is not recorded for this device.");
        }
        if (current.status === "eligible") {
          if (current.sourceHash !== sha256 || current.sourceSizeBytes !== bytes.byteLength) {
            throw new BackendError("MANIFEST_MISMATCH", "Guest object changed after eligibility was recorded.");
          }
          return;
        }
        const preIntentSnap = completionPlan ? await transaction.get(intentRef) : undefined;
        transaction.update(ref, {
          status: "eligible",
          sourceHash: sha256,
          sourceSizeBytes: bytes.byteLength,
          sourceGeneration: generation,
          completedAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromDate(eligibleExpiresAt),
          updatedAt: FieldValue.serverTimestamp(),
          // Refresh server-derived provenance with the verified source hash
          // so the generation gate binds to measured bytes (never
          // self-asserted). Original evidence (consent, revision, actor) is
          // preserved, only the hash binding is added.
          provenance: {
            ...((guestProvenanceFromDoc(
              { ...current, sourceHash: sha256 } as GuestMediaDoc,
              "server:guest_upload",
            ) ?? (current as unknown as Record<string, unknown>).provenance) as Record<string, unknown>),
            sourceHash: sha256,
          },
        });
        // Same-transaction durable intent: bound to party+submission+consent
        // revision with the immutable plan. Created once, never rerolled:
        // an existing intent keeps its plan.
        if (completionPlan) {
          const intentSnap = preIntentSnap!;
          if (!intentSnap.exists) {
            transaction.create(intentRef, {
              partyId: identity.partyId,
              deviceId: identity.deviceId,
              channelId: identity.channelId,
              submissionId,
              consentRevision: current.consentRevision,
              sourceHash: sha256,
              plan: completionPlan,
              status: "pending",
              attempts: 0,
              createdAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            });
          } else {
            const kept = intentSnap.data() as Record<string, unknown>;
            if (kept.status === "unavailable") {
              // A terminal admission failure stays terminal: completion
              // replays never resurrect it into pending.
            } else if (!plansEqual(kept.plan, completionPlan)) {
              // Catalog drift must never reroll the persisted plan: keep it.
            }
          }
        }
      });
    } catch (error) {
      if (error instanceof BackendError && error.errorCode === "CLIP_EXPIRED" && doc.status !== "expired") {
        // Best-effort expiry marking already handled inside the transaction.
      }
      throw error;
    }
    // Eligible-upload completion idempotently enqueues the backend-selected
    // two-stage cartoon generation (best-effort: never breaks completion).
    // On a busy party the durable intent above persists pending and a bounded
    // server dispatch queues it after capacity releases; the guest does
    // nothing further.
    await notifyPortraitEligible({ partyId: identity.partyId, deviceId: identity.deviceId, channelId: identity.channelId, submissionId, hostSource: completionHostSource });
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
    // Durable queue state (fix-5a): intent first, then the deterministic job.
    // Withdrawn/expired docs never carry queue state (the intent is cleaned
    // up and never dispatches). A TERMINAL unavailable intent is surfaced
    // here so the guest never polls eligible-forever after an unrecoverable
    // queue admission failure.
    if (doc.status === "eligible" || doc.status === "pending_upload") {
      try {
        const intentSnap = await db.doc(pendingCartoonIntentPath(identity.partyId, submissionId)).get();
        const intent = intentSnap.exists ? (intentSnap.data() as Record<string, unknown>) : undefined;
        if (intent && intent.status === "unavailable") {
          result.generation = {
            state: "unavailable",
            ...(typeof intent.errorCode === "string" ? { errorCode: intent.errorCode } : { errorCode: "PROVIDER_UNAVAILABLE" }),
            ...(intent.plan !== undefined ? { plan: intent.plan as PendingCartoonIntentPlan } : {}),
          };
          return result;
        }
        const jobId = `cartoon-${submissionId}`;
        const jobSnap = await db.doc(`parties/${identity.partyId}/jobs/${jobId}`).get().catch(() => undefined);
        const job = jobSnap?.exists ? (jobSnap.data() as Record<string, unknown>) : undefined;
        if (job) {
          const state = String(job.state ?? job.status ?? "queued");
          const mapped: GenerationQueueState =
            state === "ready" || state === "delivering" || state === "purged" ? "ready"
            : state === "failed" || state === "expired" ? "failed"
            : "queued";
          result.generation = {
            state: mapped,
            jobId,
            ...(typeof job.errorCode === "string" ? { errorCode: job.errorCode } : {}),
            ...((job.cartoonPlan ?? intent?.plan) !== undefined
              ? { plan: (job.cartoonPlan ?? intent?.plan) as PendingCartoonIntentPlan }
              : {}),
          };
          return result;
        }
        if (intent && intent.status === "queued") {
          result.generation = {
            state: "queued",
            jobId,
            ...(intent.plan !== undefined ? { plan: intent.plan as PendingCartoonIntentPlan } : {}),
          };
          return result;
        }
        if (intent && intent.status === "pending") {
          result.generation = {
            state: "pending",
            ...(intent.plan !== undefined ? { plan: intent.plan as PendingCartoonIntentPlan } : {}),
          };
          return result;
        }
      } catch {
        // Status stays operational without queue detail.
      }
    }
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
    const withdrawnAt = (doc as GuestMediaDoc & { withdrawnAt?: unknown }).withdrawnAt;
    const withdrawnAtIso = typeof withdrawnAt === "string" && Number.isFinite(Date.parse(withdrawnAt))
      ? withdrawnAt
      : now().toISOString();
    // Preserve the immutable creation-based deletion deadline across the
    // tombstone rewrite so retention still bounds the (now deleted) input.
    const existingDeleteAt = (doc as unknown as Record<string, unknown>).deleteAt;
    // Revoke eligibility first so concurrent submissions and publication fail closed.
    // Provenance is preserved, never erased: the original evidence
    // (actor, consent pair, revision, hashes) is retained and only marked
    // withdrawn, so audits keep the full history.
    const existingProvenance = (doc as unknown as Record<string, unknown>).provenance;
    let withdrawnProvenance: unknown;
    try {
      const base = guestProvenanceFromDoc(doc, "server:guest_upload") ??
        (existingProvenance as Parameters<typeof markProvenanceWithdrawn>[0]);
      withdrawnProvenance = markProvenanceWithdrawn(base, withdrawnAtIso);
    } catch {
      withdrawnProvenance = existingProvenance;
    }
    await ref.set({
      submissionId,
      partyId: identity.partyId,
      deviceId: identity.deviceId,
      channelId: identity.channelId,
      status: "withdrawn",
      consent: doc.consent,
      consentRevision: doc.consentRevision,
      ...((doc as unknown as Record<string, unknown>).attestation !== undefined
        ? { attestation: (doc as unknown as Record<string, unknown>).attestation }
        : {}),
      ...(withdrawnProvenance !== undefined ? { provenance: withdrawnProvenance } : {}),
      objectPath,
      contentType: doc.contentType,
      expiresAt: doc.expiresAt,
      ...(existingDeleteAt !== undefined ? { deleteAt: existingDeleteAt } : {}),
      createdAt: doc.createdAt,
      withdrawnAt: withdrawnAtIso,
      tombstone: true,
      pendingDeletions: [],
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: false });
    // Withdrawn pending never dispatches: remove the durable intent first so
    // a concurrent dispatch cannot queue it after the tombstone.
    await db.doc(pendingCartoonIntentPath(identity.partyId, submissionId)).delete().catch(() => undefined);
    // Discard every attributable object: the source plus staged, delivered,
    // and generated derivatives of all bound jobs plus the published manifest
    // clips. Delivery eligibility is revoked immediately by deleting a current
    // manifest produced from this submission, so no new delivery URLs can be
    // issued post-withdrawal.
    const attributable = new Set<string>([objectPath]);
    const jobs = await db.collection(`parties/${identity.partyId}/jobs`).where("guestMedia.submissionId", "==", submissionId).get();
    // Cartoon jobs bind their portrait chain-only (cartoonChain.
    // portraitSubmissionId set at request time); match them too so the
    // withdrawal fails the job, revokes its manifest, and collects its
    // generated still. Merged with the guestMedia-bound set (dedup by id).
    const chainJobs = await db.collection(`parties/${identity.partyId}/jobs`).where("cartoonChain.portraitSubmissionId", "==", submissionId).get().catch(() => ({ docs: [] as typeof jobs.docs }));
    const seenJobIds = new Set<string>();
    const boundJobs = [...jobs.docs, ...chainJobs.docs].filter((jobDoc) => {
      if (seenJobIds.has(jobDoc.id)) return false;
      seenJobIds.add(jobDoc.id);
      return true;
    });
    const boundJobIds: string[] = [];
    for (const jobDoc of boundJobs) {
      boundJobIds.push(jobDoc.id);
      const job = jobDoc.data() as Record<string, unknown>;
      // Shared collector covers staged outputs, delivery + generated paths,
      // cartoon stills, intermediate outputs, and delivery objects under both
      // current and historical field names. Audit/accounting rows are never
      // paths and are never collected.
      for (const path of collectJobDerivativePaths(job)) attributable.add(path);
    }
    // Host seed catalog integration: previews retained for bound jobs are
    // attributable derivatives too. They are queued for deletion here and
    // their seed entries are failed closed so no preview is recreated and no
    // deleted/withdrawn binding republishes (publish.ts rechecks the job
    // tombstone transactionally).
    try {
      const seeds = await db.collection(`parties/${identity.partyId}/seedVideos`).get();
      for (const seedDoc of seeds.docs) {
        const seed = seedDoc.data() as Record<string, unknown>;
        if (typeof seed.jobId !== "string" || !boundJobIds.includes(seed.jobId)) continue;
        for (const key of ["previewPaths", "stillPaths", "intermediatePaths"] as const) {
          const listed = seed[key];
          if (Array.isArray(listed)) {
            for (const item of listed) if (typeof item === "string" && item.startsWith("parties/")) attributable.add(item);
          }
        }
        for (const key of ["cartoonStillPath", "stillPath"] as const) {
          const single = seed[key];
          if (typeof single === "string" && single.startsWith("parties/")) attributable.add(single);
        }
        if (seed.status !== "deleted") {
          await seedDoc.ref.update({
            status: "failed",
            reconciliationReason: "GUEST_CONSENT_WITHDRAWN",
            updatedAt: FieldValue.serverTimestamp(),
          }).catch(() => undefined);
        }
        const boundJob = await db.doc(`parties/${identity.partyId}/jobs/${seed.jobId}`).get().catch(() => undefined);
        if (boundJob?.exists && (boundJob.data() as Record<string, unknown>).hostDeleted !== true) {
          await boundJob.ref.update({
            hostDeleted: true,
            reconciliationReason: "GUEST_CONSENT_WITHDRAWN",
            timestamp: FieldValue.serverTimestamp(),
          }).catch(() => undefined);
        }
      }
    } catch {
      // Best-effort: delivery paths additionally refuse withdrawn bindings,
      // and retention retries revoked-manifest objects.
    }
    // Published manifest clips attributable to a bound job are deliverable
    // until revoked: collect them here and delete the manifest doc below.
    let revokedManifestPaths: string[] = [];
    try {
      const currentRef = db.doc(`parties/${identity.partyId}/manifests/current_${identity.channelId}`);
      const current = await currentRef.get();
      if (current.exists) {
        const manifest = current.data() as Record<string, unknown>;
        if (typeof manifest.jobId === "string" && boundJobIds.includes(manifest.jobId)) {
          const clips = manifest.cameraClips;
          if (Array.isArray(clips)) {
            for (const clip of clips) {
              if (clip && typeof clip === "object" && typeof (clip as Record<string, unknown>).objectPath === "string") {
                const path = (clip as Record<string, unknown>).objectPath as string;
                if (path.startsWith("parties/")) {
                  attributable.add(path);
                  revokedManifestPaths.push(path);
                }
              }
            }
          }
        }
      }
    } catch {
      revokedManifestPaths = [...attributable].filter((p) => p.includes("/delivery/"));
    }
    const deletedObjects: string[] = [];
    const pendingDeletions: string[] = [];
    for (const path of attributable) {
      try {
        await deleteWithRetry(deleteObject, bucket.file(path));
        deletedObjects.push(path);
      } catch {
        // Persisted below for the sweeper; verifiedAbsent stays false until
        // every attributable object is confirmed absent.
        pendingDeletions.push(path);
      }
    }
    // Fail bound jobs closed with budget-pointer release (same semantics as
    // the worker-side failForWithdrawnConsent path).
    const budgetRef = db.doc(`parties/${identity.partyId}/generationBudget/active`);
    for (const jobDoc of boundJobs) {
      const job = jobDoc.data() as Record<string, unknown>;
      if (["failed", "purged", "expired"].includes(String(job.state))) {
        await db.runTransaction(async (transaction) => {
          const budget = await transaction.get(budgetRef);
          if (budget.exists && budget.data()?.activeJobId === jobDoc.id) {
            transaction.update(budgetRef, { activeJobId: null, state: "idle", updatedAt: FieldValue.serverTimestamp() });
          }
        }).catch(() => undefined);
        continue;
      }
      await db.runTransaction(async (transaction) => {
        const [current, budget] = await Promise.all([transaction.get(jobDoc.ref), transaction.get(budgetRef)]);
        if (!current.exists) return;
        transaction.update(jobDoc.ref, {
          state: "failed",
          status: "failed",
          errorCode: "FORBIDDEN",
          reconciliationReason: "GUEST_CONSENT_WITHDRAWN",
          failedAt: FieldValue.serverTimestamp(),
          timestamp: FieldValue.serverTimestamp(),
          workerLeaseUntilMs: 0,
        });
        if (budget.exists && budget.data()?.activeJobId === jobDoc.id) {
          transaction.update(budgetRef, { activeJobId: null, state: "idle", updatedAt: FieldValue.serverTimestamp() });
        }
      }).catch(() => undefined);
    }
    // Revoke the deliverable manifest after its bytes are deleted.
    try {
      const currentRef = db.doc(`parties/${identity.partyId}/manifests/current_${identity.channelId}`);
      const current = await currentRef.get();
      if (current.exists) {
        const manifest = current.data() as Record<string, unknown>;
        if (typeof manifest.jobId === "string" && boundJobIds.includes(manifest.jobId)) {
          await currentRef.delete().catch(() => undefined);
        }
      }
    } catch {
      // Revocation best-effort: delivery paths additionally refuse withdrawn
      // bindings, and retention retries revoked-manifest objects.
    }
    // verifiedAbsent ONLY after every attributable object (source + staged +
    // delivered + generated) is confirmed absent.
    let verifiedAbsent = pendingDeletions.length === 0;
    if (verifiedAbsent) {
      for (const path of attributable) {
        try {
          const [stillExists] = await bucket.file(path).exists();
          if (stillExists) {
            verifiedAbsent = false;
            pendingDeletions.push(path);
          }
        } catch {
          verifiedAbsent = false;
          pendingDeletions.push(path);
        }
      }
    }
    // Order the source first for stable assertions, without duplicating it.
    const orderedDeleted = [
      ...(deletedObjects.includes(objectPath) ? [objectPath] : []),
      ...deletedObjects.filter((p) => p !== objectPath),
    ];
    await ref.update({
      pendingDeletions,
      revokedManifestPaths,
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => undefined);
    return { submissionId, status: "withdrawn", deletedObjects: orderedDeleted, verifiedAbsent };
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
    // Ingest-finalization race: when the object arrives after (or is replayed
    // after) an eligible completion, enqueue idempotently exactly once
    // downstream. Pending uploads are left alone; explicit completion
    // validates bytes before any eligibility change. Host-source portraits
    // skip the guest auto path (explicit host seed request owns that scope).
    if (doc.status === "eligible") {
      const hostSource = isHostSourceConsent(
        (doc.consent as GuestMediaDoc["consent"] | undefined)?.textVersion,
        (doc.consent as GuestMediaDoc["consent"] | undefined)?.purpose,
      );
      if (!hostSource && onPortraitEligible && typeof doc.sourceHash === "string") {
        const finalizePlan = (() => { try { return planForSubmission(parsed.submissionId); } catch { return undefined; } })();
        if (finalizePlan) {
          const intentRef = db.doc(pendingCartoonIntentPath(parsed.partyId, parsed.submissionId));
          await db.runTransaction(async (transaction) => {
            const [fresh, intentSnap] = await Promise.all([
              transaction.get(guestMediaRef(db, parsed.partyId, parsed.submissionId)),
              transaction.get(intentRef),
            ]);
            if (!fresh.exists) return;
            const current = fresh.data() as GuestMediaDoc;
            if (current.status !== "eligible") return;
            if ((current as GuestMediaDoc & { tombstone?: unknown }).tombstone === true || String(current.status) === "withdrawn") return;
            if (!intentSnap.exists && typeof current.sourceHash === "string") {
              transaction.create(intentRef, {
                partyId: current.partyId,
                deviceId: current.deviceId,
                channelId: current.channelId,
                submissionId: parsed.submissionId,
                consentRevision: current.consentRevision,
                sourceHash: current.sourceHash,
                plan: finalizePlan,
                status: "pending",
                attempts: 0,
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
              });
            }
          }).catch(() => undefined);
        }
      }
      await notifyPortraitEligible({ partyId: parsed.partyId, deviceId: parsed.deviceId, channelId: doc.channelId, submissionId: parsed.submissionId, hostSource });
    }
    return { handled: true, deleted: false };
  }

  return { requestGuestUpload, completeGuestUpload, getGuestMediaStatus, withdrawGuestMedia, handleIngestFinalized };
}

export type GuestUploadServices = ReturnType<typeof createGuestUploadService>;
