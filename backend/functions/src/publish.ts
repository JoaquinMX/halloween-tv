import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { assertCartoonChainComplete, BackendError, CanonicalClip, DeliveryManifest, evaluateDeliveryProvenance, isExplicitlySupportedLegacyArtifact, isSupportedConsent, validateCanonicalClips } from "./contracts";
import { GUEST_PROVIDER_CAMERA_ID, SCHEMA_VERSION, REQUIRED_CAMERA_IDS } from "./config";
import { FirestoreGenerationStore } from "./generation_store";
import { GuestMediaDoc } from "./guest_media";
import { usageLedgerPath } from "./usage";

function isClip(value: unknown): value is CanonicalClip {
  return value !== null && typeof value === "object" &&
    typeof (value as CanonicalClip).cameraId === "string" &&
    typeof (value as CanonicalClip).objectPath === "string" &&
    typeof (value as CanonicalClip).sha256 === "string" &&
    Number.isSafeInteger((value as CanonicalClip).sizeBytes) &&
    Number.isSafeInteger((value as CanonicalClip).durationMs) &&
    typeof (value as CanonicalClip).expiresAt === "string";
}

export function guestMediaOf(job: FirebaseFirestore.DocumentData): {
  submissionId: string;
  sourceHash: string;
  consentRevision: string;
} | undefined {
  const guest = job.guestMedia as Record<string, unknown> | undefined;
  if (!guest || typeof guest.submissionId !== "string" || typeof guest.sourceHash !== "string" ||
      typeof guest.consentRevision !== "string") return undefined;
  return { submissionId: guest.submissionId, sourceHash: guest.sourceHash, consentRevision: guest.consentRevision };
}

export function seedProvenanceOf(job: FirebaseFirestore.DocumentData): {
  seedId: string;
  kind: string;
} | undefined {
  const seed = (job as Record<string, unknown>).seedProvenance as Record<string, unknown> | undefined;
  if (!seed || typeof seed.seedId !== "string" || typeof seed.kind !== "string") return undefined;
  return { seedId: seed.seedId, kind: seed.kind };
}

function assertGuestBinding(
  job: FirebaseFirestore.DocumentData,
  guest: GuestMediaDoc,
  nowMs: number,
): void {
  const binding = guestMediaOf(job)!;
  // Irreversible withdrawal: a tombstone can never publish again, even if a
  // racing completion wrote eligible around the withdrawal.
  if ((guest as GuestMediaDoc & { tombstone?: unknown }).tombstone === true) {
    throw new BackendError("FORBIDDEN", "[authorization] Guest consent was withdrawn.");
  }
  if (guest.status !== "eligible") throw new BackendError("FORBIDDEN", "[authorization] Guest consent is no longer eligible for publication.");
  if (!guest.consent || guest.consent.accepted !== true ||
      !isSupportedConsent(guest.consent.textVersion, guest.consent.purpose)) {
    throw new BackendError("FORBIDDEN", "[authorization] Guest consent is not recorded for publication.");
  }
  if (guest.sourceHash !== binding.sourceHash || guest.consentRevision !== binding.consentRevision) {
    throw new BackendError("FORBIDDEN", "[authorization] Guest media changed while the job was running.");
  }
  if (guest.partyId !== undefined && guest.partyId !== (job as Record<string, unknown>).partyId) {
    throw new BackendError("FORBIDDEN", "[authorization] Guest media is not authorized for this party and channel.");
  }
  const expiry = guest.expiresAt instanceof Date ? guest.expiresAt.getTime() : Date.parse(String(
    guest.expiresAt && typeof guest.expiresAt === "object" && "toDate" in guest.expiresAt
      ? (guest.expiresAt as { toDate: () => Date }).toDate().toISOString()
      : guest.expiresAt,
  ));
  if (!Number.isFinite(expiry) || expiry <= nowMs) throw new BackendError("FORBIDDEN", "[authorization] Guest consent window has expired.");
}

/**
 * Scoped publication provenance gate (cycle-13).
 *
 * - Cartoon jobs require the completed still-to-video chain with matching
 *   stage provenance before anything else.
 * - Guest-bound jobs use the consent gate above (withdrawn/expired/deleted/
 *   changed-source/unknown/unauthorized bindings fail explicitly).
 * - Legacy/operator/host seed artifacts publish WITHOUT fabricated mobile
 *   consent when they are explicitly supported; anything else fails closed.
 * - Database read failures fail closed (INTERNAL), never fail-open.
 */
export function assertScopedPublishProvenance(
  job: FirebaseFirestore.DocumentData,
  guest: GuestMediaDoc | undefined,
  guestReadError: unknown,
  seed: Record<string, unknown> | undefined,
  seedReadError: unknown,
  nowMs: number,
): void {
  if ((job as Record<string, unknown>).cartoonChain !== undefined) {
    assertCartoonChainComplete(job as Record<string, unknown>);
  }
  evaluateDeliveryProvenance({
    job: job as Record<string, unknown>,
    guest: guest as Record<string, unknown> | undefined,
    guestReadError,
    seed,
    seedReadError,
    nowMs,
  });
}

async function readProvenanceDocs(
  store: FirestoreGenerationStore,
  partyId: string,
  job: FirebaseFirestore.DocumentData,
): Promise<{ guest: GuestMediaDoc | undefined; guestReadError: unknown; seed: Record<string, unknown> | undefined; seedReadError: unknown }> {
  const guest = guestMediaOf(job);
  const seed = seedProvenanceOf(job);
  let guestDoc: GuestMediaDoc | undefined;
  let guestReadError: unknown;
  let seedDoc: Record<string, unknown> | undefined;
  let seedReadError: unknown;
  if (guest) {
    try {
      const snapshot = await store.db.doc(`parties/${partyId}/guestMedia/${guest.submissionId}`).get();
      guestDoc = snapshot.exists ? (snapshot.data() as GuestMediaDoc) : undefined;
    } catch (error) {
      guestReadError = error;
    }
  }
  if (seed) {
    try {
      const snapshot = await store.db.doc(`parties/${partyId}/seedVideos/${seed.seedId}`).get();
      seedDoc = snapshot.exists ? (snapshot.data() as Record<string, unknown>) : undefined;
    } catch (error) {
      seedReadError = error;
    }
  } else if (typeof job.jobId === "string" && job.jobId.startsWith("hv-")) {
    // Host-seed jobs carry their authorization in the seed catalog entry.
    const seedId = job.jobId.slice("hv-".length);
    try {
      const snapshot = await store.db.doc(`parties/${partyId}/seedVideos/${seedId}`).get();
      if (snapshot.exists) {
        seedDoc = snapshot.data() as Record<string, unknown>;
        (job as Record<string, unknown>).seedProvenance = { seedId, kind: "host" };
      }
    } catch (error) {
      seedReadError = error;
    }
  }
  // Cartoon portrait bindings resolve through the same scoped gate: when the
  // chain cites a guest portrait, load that guest doc for evaluation.
  const chain = (job as Record<string, unknown>).cartoonChain as Record<string, unknown> | undefined;
  if (chain && typeof chain.portraitSubmissionId === "string" && chain.portraitSubmissionId !== "" && !guest) {
    try {
      const snapshot = await store.db.doc(`parties/${partyId}/guestMedia/${String(chain.portraitSubmissionId)}`).get();
      guestDoc = snapshot.exists ? (snapshot.data() as GuestMediaDoc) : undefined;
    } catch (error) {
      guestReadError = error;
    }
  }
  return { guest: guestDoc, guestReadError, seed: seedDoc, seedReadError };
}

/** Publishes the current manifest in one Firestore transaction after all four objects exist. */
export async function publishManifest(
  store: FirestoreGenerationStore,
  partyId: string,
  jobId: string,
  idempotencyKey: string,
): Promise<DeliveryManifest> {
  const job = await store.getJob(partyId, jobId);
  if (job.idempotencyKey !== idempotencyKey) throw new BackendError("FORBIDDEN", "Publish idempotency key does not match the job.");
  // Deletion-race guard: a host-deleted job (deleteHostVideo tombstone) must
  // never publish, even if the worker staged bytes before the deletion. This
  // precedes the idempotent-published fast path so a deletion racing the
  // worker is refused instead of replaying the revoked manifest.
  if ((job as Record<string, unknown>).hostDeleted === true) {
    throw new BackendError("FORBIDDEN", "Seed video was deleted; publication is refused.");
  }
  if (typeof job.jobId === "string" && job.jobId.startsWith("hv-")) {
    const seedId = job.jobId.slice("hv-".length);
    let seedSnap: FirebaseFirestore.DocumentSnapshot | undefined;
    try {
      seedSnap = await store.db.doc(`parties/${partyId}/seedVideos/${seedId}`).get();
    } catch {
      throw new BackendError("INTERNAL", "[authorization] Seed authorization evidence is unreadable; failing closed.");
    }
    if (seedSnap?.exists && (seedSnap.data() as Record<string, unknown>).status === "deleted") {
      throw new BackendError("FORBIDDEN", "[authorization] Seed video was deleted; publication is refused.");
    }
  }
  if (job.publishedManifest) return job.publishedManifest as DeliveryManifest;
  const provenance = await readProvenanceDocs(store, partyId, job);
  assertScopedPublishProvenance(job, provenance.guest, provenance.guestReadError, provenance.seed, provenance.seedReadError, Date.now());
  const guest = guestMediaOf(job);
  const staged = job.stagedOutputs && typeof job.stagedOutputs === "object"
    ? job.stagedOutputs as Record<string, unknown>
    : {};
  const providerTasks = job.providerTasks && typeof job.providerTasks === "object"
    ? job.providerTasks as Record<string, { taskId?: unknown }>
    : {};
  const clips: CanonicalClip[] = [];
  for (const cameraId of REQUIRED_CAMERA_IDS) {
    const clip = staged[cameraId];
    if (!isClip(clip) || clip.cameraId !== cameraId) {
      throw new BackendError("MANIFEST_MISMATCH", "All four normalized camera clips must be staged before publishing.");
    }
    const expectedPath = store.plannedObjectPath(partyId, String(job.channelId), Number(job.manifestVersion), cameraId);
    if (clip.objectPath !== expectedPath) throw new BackendError("MANIFEST_MISMATCH", "Staged camera path is outside the delivery prefix.");
    const [exists] = await store.bucket.file(clip.objectPath).exists();
    if (!exists) throw new BackendError("MANIFEST_MISMATCH", "A staged camera clip is not present in delivery storage.");
    const [bytes] = await store.bucket.file(clip.objectPath).download();
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== clip.sha256 || bytes.byteLength !== clip.sizeBytes) {
      throw new BackendError("MANIFEST_MISMATCH", "Staged camera content does not match its recorded hash and size.");
    }
    const taskId = providerTasks[cameraId]?.taskId;
    const isFixtureSlot = guest !== undefined && cameraId !== GUEST_PROVIDER_CAMERA_ID;
    const ledgerInput = {
      partyId,
      deviceId: String(job.deviceId),
      channelId: String(job.channelId),
      manifestVersion: Number(job.manifestVersion),
      idempotencyKey,
      jobId,
      cameraId,
    };
    const ledger = await store.db.doc(usageLedgerPath(ledgerInput)).get();
    if (isFixtureSlot) {
      // Locally prepared fixture slot: truthful provenance, no provider task
      // ID or charge is ever fabricated for these cameras.
      if (!ledger.exists || ledger.data()?.provider_task_id !== null || ledger.data()?.fixture !== true ||
          ledger.data()?.success !== true) {
        throw new BackendError("MANIFEST_MISMATCH", "Usage ledger is incomplete for a staged fixture clip.");
      }
      clips.push(clip);
      continue;
    }
    if (typeof taskId !== "string") throw new BackendError("MANIFEST_MISMATCH", "Every staged camera clip needs a persisted provider task ID.");
    if (!ledger.exists || ledger.data()?.provider_task_id !== taskId || ledger.data()?.success !== true) {
      throw new BackendError("MANIFEST_MISMATCH", "Usage ledger is incomplete for a staged provider result.");
    }
    clips.push(clip);
  }
  validateCanonicalClips(clips);
  const sourceVersion = Number(job.sourceManifestVersion);
  const plannedVersion = Number(job.manifestVersion);
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 0 || plannedVersion !== sourceVersion + 1) {
    throw new BackendError("MANIFEST_MISMATCH", "Job manifest version is invalid.");
  }
  const expiresAt = clips.reduce((earliest, clip) => Date.parse(clip.expiresAt) < Date.parse(earliest) ? clip.expiresAt : earliest, clips[0].expiresAt);
  const manifest: DeliveryManifest = {
    partyId,
    channelId: String(job.channelId),
    version: plannedVersion,
    schemaVersion: SCHEMA_VERSION,
    jobId,
    cameraClips: clips,
    expiresAt,
  };
  const currentRef = store.currentManifestRef(partyId, String(job.channelId));
  const ref = store.jobDocumentRef(partyId, jobId);
  const budgetRef = store.db.doc(`parties/${partyId}/generationBudget/active`);
  return store.db.runTransaction(async (transaction) => {
    const guestBinding = guestMediaOf(job);
    const seedBinding = seedProvenanceOf(job);
    const chain = (job as Record<string, unknown>).cartoonChain as Record<string, unknown> | undefined;
    const portraitSubmissionId = chain && typeof chain.portraitSubmissionId === "string" && chain.portraitSubmissionId !== ""
      ? String(chain.portraitSubmissionId)
      : undefined;
    const guestRef = guestBinding
      ? store.db.doc(`parties/${partyId}/guestMedia/${guestBinding.submissionId}`)
      : portraitSubmissionId && !seedBinding
        ? store.db.doc(`parties/${partyId}/guestMedia/${portraitSubmissionId}`)
        : undefined;
    const seedRef = seedBinding ? store.db.doc(`parties/${partyId}/seedVideos/${seedBinding.seedId}`) : undefined;
    const [jobSnapshot, currentSnapshot, budgetSnapshot, guestSnapshot, seedSnapshot] = await Promise.all([
      transaction.get(ref),
      transaction.get(currentRef),
      transaction.get(budgetRef),
      ...(guestRef ? [transaction.get(guestRef)] : [Promise.resolve(undefined)]),
      ...(seedRef ? [transaction.get(seedRef)] : [Promise.resolve(undefined)]),
    ]);
    const currentJob = jobSnapshot.data();
    if (!currentJob || currentJob.idempotencyKey !== idempotencyKey) {
      throw new BackendError("FORBIDDEN", "Publish idempotency key does not match the job.");
    }
    // Transactional recheck of the deletion tombstone: a deleteHostVideo
    // racing the worker fails the publication instead of republishing. This
    // precedes the idempotent-published fast path for the same reason.
    if ((currentJob as Record<string, unknown>).hostDeleted === true) {
      throw new BackendError("FORBIDDEN", "[authorization] Seed video was deleted; publication is refused.");
    }
    if (currentJob.publishedManifest) return currentJob.publishedManifest as DeliveryManifest;
    if (currentJob.state !== "running") throw new BackendError("MANIFEST_MISMATCH", "[manifest] Only a running job can publish a manifest.");
    {
      // Transactional consent/provenance gate: a withdrawal or deletion
      // racing the worker fails the publication instead of publishing a
      // revoked artifact. Read failures fail closed (the transaction
      // surfaces them as INTERNAL, never as "no binding").
      const replayGuest = (guestSnapshot && guestSnapshot.exists ? guestSnapshot.data() : undefined) as GuestMediaDoc | undefined;
      const replaySeed = (seedSnapshot && seedSnapshot.exists ? seedSnapshot.data() : undefined) as Record<string, unknown> | undefined;
      const needsGuestDoc = guestBinding !== undefined || (portraitSubmissionId !== undefined && seedBinding === undefined);
      const needsSeedDoc = seedBinding !== undefined;
      if (needsGuestDoc && !replayGuest) {
        throw new BackendError("FORBIDDEN", "[authorization] Guest consent is no longer eligible for publication.");
      }
      if (needsSeedDoc && !replaySeed) {
        throw new BackendError("NOT_FOUND", "[authorization] Seed artifact is unknown; publication is refused.");
      }
      assertScopedPublishProvenance(currentJob, replayGuest, undefined, replaySeed, undefined, Date.now());
    }
    const currentVersion = currentSnapshot.exists ? Number(currentSnapshot.data()?.version ?? 0) : 0;
    if (currentVersion !== sourceVersion || plannedVersion <= currentVersion) {
      throw new BackendError("MANIFEST_MISMATCH", "Current manifest changed while this job was running.");
    }
    const published = { ...manifest, createdAt: FieldValue.serverTimestamp() };
    transaction.set(currentRef, published);
    transaction.update(ref, {
      state: "ready",
      status: "ready",
      publishedManifest: manifest,
      readyAt: FieldValue.serverTimestamp(),
      workerLeaseUntilMs: 0,
      timestamp: FieldValue.serverTimestamp(),
    });
    if (budgetSnapshot.exists && budgetSnapshot.data()?.activeJobId === jobId) {
      transaction.update(budgetRef, { activeJobId: null, state: "idle", updatedAt: FieldValue.serverTimestamp() });
    }
    return manifest;
  });
}
