import { Bucket } from "@google-cloud/storage";
import { FieldValue, Firestore, Timestamp } from "firebase-admin/firestore";
import { BackendError } from "./contracts";

function expiryDate(value: unknown): Date | undefined {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const result = new Date(value);
    return Number.isFinite(result.getTime()) ? result : undefined;
  }
  return undefined;
}

function addPaths(target: Set<string>, value: unknown): void {
  if (Array.isArray(value)) for (const item of value) if (typeof item === "string" && item.startsWith("parties/")) target.add(item);
}

export interface RetentionResult {
  expiredJobs: number;
  deletedExpiredObjects: number;
  deletedOrphanObjects: number;
  expiredGuestInputs: number;
}

/** Scheduled TTL transition plus orphan cleanup; object deletion is idempotent. */
export async function sweepExpiredMedia(
  db: Firestore,
  bucket: Bucket,
  now = new Date(),
): Promise<RetentionResult> {
  const expiredSnapshot = await db.collectionGroup("jobs")
    .where("expiresAt", "<=", Timestamp.fromDate(now))
    .get();
  let expiredJobs = 0;
  for (const snapshot of expiredSnapshot.docs) {
    const job = snapshot.data();
    const paths = new Set<string>();
    addPaths(paths, job.deliveryPaths);
    addPaths(paths, job.generatedPaths);
    // Staged camera outputs of a dead job are temporary: purge them here so
    // they do not linger past expiry (live staged outputs are protected by
    // the references set below, never by this block).
    const staged = job.stagedOutputs;
    if (staged && typeof staged === "object") {
      for (const clip of Object.values(staged as Record<string, unknown>)) {
        if (clip && typeof clip === "object" && typeof (clip as Record<string, unknown>).objectPath === "string" &&
            ((clip as Record<string, unknown>).objectPath as string).startsWith("parties/")) {
          paths.add((clip as Record<string, unknown>).objectPath as string);
        }
      }
    }
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(snapshot.ref);
      if (!current.exists) return;
      const data = current.data()!;
      if (data.state !== "purged" && data.state !== "expired") {
        transaction.update(snapshot.ref, {
          state: "expired",
          errorCode: "CLIP_EXPIRED",
          expiredAt: FieldValue.serverTimestamp(),
          timestamp: FieldValue.serverTimestamp(),
        });
        expiredJobs += 1;
      }
    });
    await Promise.all([...paths].map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
  }

  const references = new Set<string>();
  const liveJobPairs = new Set<string>();
  const [manifests, jobs, guestMedia] = await Promise.all([
    db.collectionGroup("manifests").get(),
    db.collectionGroup("jobs").get(),
    db.collectionGroup("guestMedia").get(),
  ]);
  // Guest consent inputs: live (unexpired, not withdrawn) ingest objects are
  // protected from the orphan sweep. Abandoned pending uploads and expired
  // eligible inputs are removed within the capped 24h input TTL below.
  let expiredGuestInputs = 0;
  for (const guestDoc of guestMedia.docs) {
    const guest = guestDoc.data();
    const objectPath = typeof guest.objectPath === "string" ? guest.objectPath : undefined;
    const expiry = expiryDate(guest.expiresAt);
    const liveGuest = (guest.status === "pending_upload" || guest.status === "eligible") &&
      expiry !== undefined && expiry > now;
    if (liveGuest && objectPath && objectPath.startsWith("parties/")) {
      references.add(objectPath);
      continue;
    }
    if ((guest.status === "pending_upload" || guest.status === "eligible") && objectPath && objectPath.startsWith("parties/")) {
      let deleted = false;
      for (let attempt = 0; attempt < 3 && !deleted; attempt += 1) {
        try {
          await bucket.file(objectPath).delete({ ignoreNotFound: true });
          deleted = true;
        } catch {
          deleted = false;
        }
      }
      if (deleted) expiredGuestInputs += 1;
      // Minimize retained audit metadata once the deadline passes.
      await guestDoc.ref.update({
        status: "expired",
        sourceHash: FieldValue.delete(),
        sourceSizeBytes: FieldValue.delete(),
        sourceGeneration: FieldValue.delete(),
        contentType: FieldValue.delete(),
        expiredAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }).catch(() => undefined);
    }
  }
  for (const manifestDoc of manifests.docs) {
    const manifest = manifestDoc.data();
    const expiry = expiryDate(manifest.expiresAt);
    if (expiry && expiry > now && Array.isArray(manifest.cameraClips)) {
      for (const clip of manifest.cameraClips) if (typeof clip?.objectPath === "string") references.add(clip.objectPath);
    }
  }
  for (const jobDoc of jobs.docs) {
    const job = jobDoc.data();
    const expiry = expiryDate(job.expiresAt);
    if (expiry && expiry > now && !["expired", "purged", "failed"].includes(String(job.state))) {
      const pairParty = jobDoc.ref.parent.parent?.id ?? "";
      if (typeof jobDoc.id === "string" && jobDoc.id && pairParty) liveJobPairs.add(`${pairParty}/${jobDoc.id}`);
      addPaths(references, job.deliveryPaths);
      addPaths(references, job.generatedPaths);
      // Staged camera outputs live only in job.stagedOutputs until publish;
      // without this the orphan pass deletes a running job's clips.
      const staged = job.stagedOutputs;
      if (staged && typeof staged === "object") {
        for (const clip of Object.values(staged as Record<string, unknown>)) {
          if (clip && typeof clip === "object" && typeof (clip as Record<string, unknown>).objectPath === "string") {
            references.add((clip as Record<string, unknown>).objectPath as string);
          }
        }
      }
    }
  }

  const [files] = await bucket.getFiles({ prefix: "parties/" });
  let deletedExpiredObjects = 0;
  let deletedOrphanObjects = 0;
  for (const file of files) {
    const path = file.name;
    if (!path || path.endsWith("/")) continue;
    const [metadata] = await file.getMetadata().catch(() => [undefined]);
    const customExpiry = metadata?.metadata?.expiresAt;
    const expires = expiryDate(customExpiry);
    if (expires && expires <= now) {
      await file.delete({ ignoreNotFound: true });
      deletedExpiredObjects += 1;
      continue;
    }
    if (references.has(path)) continue;
    // Backstop for in-flight uploads whose paths are not yet listed on any
    // document (e.g. seed objects between upload and the seeding transaction):
    // a live (partyId, jobId) pair recorded in the object's own metadata
    // keeps it until the owning job leaves the live set.
    const objectJobId = metadata?.metadata?.jobId;
    const objectPartyId = metadata?.metadata?.partyId;
    if (typeof objectJobId === "string" && objectJobId && typeof objectPartyId === "string" && objectPartyId &&
        liveJobPairs.has(`${objectPartyId}/${objectJobId}`)) continue;
    await file.delete({ ignoreNotFound: true });
    deletedOrphanObjects += 1;
  }
  return { expiredJobs, deletedExpiredObjects, deletedOrphanObjects, expiredGuestInputs };
}

export function createRetentionService(db: Firestore, bucket: Bucket, clock?: () => Date) {
  return async () => sweepExpiredMedia(db, bucket, clock?.() ?? new Date());
}

