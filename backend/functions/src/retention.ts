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
  const [manifests, jobs] = await Promise.all([
    db.collectionGroup("manifests").get(),
    db.collectionGroup("jobs").get(),
  ]);
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
      addPaths(references, job.deliveryPaths);
      addPaths(references, job.generatedPaths);
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
    } else if (!references.has(path)) {
      await file.delete({ ignoreNotFound: true });
      deletedOrphanObjects += 1;
    }
  }
  return { expiredJobs, deletedExpiredObjects, deletedOrphanObjects };
}

export function createRetentionService(db: Firestore, bucket: Bucket, clock?: () => Date) {
  return async () => sweepExpiredMedia(db, bucket, clock?.() ?? new Date());
}

