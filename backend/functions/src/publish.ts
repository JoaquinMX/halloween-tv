import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { BackendError, CanonicalClip, DeliveryManifest, validateCanonicalClips } from "./contracts";
import { SCHEMA_VERSION, REQUIRED_CAMERA_IDS } from "./config";
import { FirestoreGenerationStore } from "./generation_store";
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

/** Publishes the current manifest in one Firestore transaction after all four objects exist. */
export async function publishManifest(
  store: FirestoreGenerationStore,
  partyId: string,
  jobId: string,
  idempotencyKey: string,
): Promise<DeliveryManifest> {
  const job = await store.getJob(partyId, jobId);
  if (job.idempotencyKey !== idempotencyKey) throw new BackendError("FORBIDDEN", "Publish idempotency key does not match the job.");
  if (job.publishedManifest) return job.publishedManifest as DeliveryManifest;
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
    if (typeof taskId !== "string") throw new BackendError("MANIFEST_MISMATCH", "Every staged camera clip needs a persisted provider task ID.");
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
    const [jobSnapshot, currentSnapshot, budgetSnapshot] = await Promise.all([
      transaction.get(ref),
      transaction.get(currentRef),
      transaction.get(budgetRef),
    ]);
    const currentJob = jobSnapshot.data();
    if (!currentJob || currentJob.idempotencyKey !== idempotencyKey) {
      throw new BackendError("FORBIDDEN", "Publish idempotency key does not match the job.");
    }
    if (currentJob.publishedManifest) return currentJob.publishedManifest as DeliveryManifest;
    if (currentJob.state !== "running") throw new BackendError("MANIFEST_MISMATCH", "Only a running job can publish a manifest.");
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
