import { Bucket, File } from "@google-cloud/storage";
import { FieldValue, Firestore, Timestamp } from "firebase-admin/firestore";
import {
  BackendError,
  DeleteHostVideoResult,
  GenerateHostVideoResult,
  GetHostVideoPreviewResult,
  HostSeedEntry,
  HostSeedStatus,
  parseDeleteHostVideoInput,
  parseGenerateHostVideoInput,
  parseGetHostVideoPreviewInput,
  parseListHostVideosInput,
} from "./contracts";
import {
  DELIVERY_URL_TTL_SECONDS,
  HOST_PREVIEW_TTL_MS,
  REQUIRED_CAMERA_IDS,
  hostPreviewObjectPath,
} from "./config";
import { assertRegisteredHostDevice } from "./auth";
import { FirestoreGenerationStore } from "./generation_store";

export interface HostMediaServiceOptions {
  db: Firestore;
  bucket: Bucket;
  now?: () => Date;
  signPreviewUrl?: (file: File, expiresAt: Date) => Promise<string>;
  deleteObject?: (file: File) => Promise<void>;
}

/**
 * Server-backed seed catalog (cycle-12 host administration).
 *
 * Catalog entries live at `parties/{partyId}/seedVideos/{seedId}` and carry
 * generation status plus the camera video references. Deletion granularity:
 * `deleteHostVideo` removes selected seed entries and their associated
 * preview + delivery objects, revokes an affected current manifest whose
 * jobId matches a deleted seed, and preserves accounting records (costLogs
 * / usage ledger rows are never deleted). Expiry: each seed carries
 * `expiresAt` (creation + HOST_PREVIEW_TTL_MS); the retention sweep expires
 * due seeds and deletes their preview objects, while live seeds protect
 * their preview paths from the orphan pass. Direct client access remains
 * denied: callable-only Firestore docs (catch-all deny in firestore.rules)
 * and callable-only Storage objects (catch-all deny in storage.rules);
 * preview URLs are signed on demand and never persisted.
 *
 * Previews are separately referenced (`hostPreviews/{seedId}/…`) from
 * delivery objects (`channels/{channel}/delivery/…`) and are materialized
 * before delivery objects can be ACK-purged (eagerly after the job is
 * ready, retried lazily on list/preview reads), so an ACK purge of delivery
 * bytes never removes preview bytes.
 */
export function jobIdForHostSeed(seedId: string): string {
  return `hv-${seedId}`;
}

function seedIdForHostJob(jobId: string): string | undefined {
  return jobId.startsWith("hv-") ? jobId.slice("hv-".length) : undefined;
}

function seedRef(db: Firestore, partyId: string, seedId: string) {
  return db.doc(`parties/${partyId}/seedVideos/${seedId}`);
}

function jobRef(db: Firestore, partyId: string, jobId: string) {
  return db.doc(`parties/${partyId}/jobs/${jobId}`);
}

export function createHostMediaService(options: HostMediaServiceOptions): {
  listHostVideos(value: unknown): Promise<{ videos: HostSeedEntry[] }>;
  generateHostVideo(value: unknown): Promise<GenerateHostVideoResult>;
  getHostVideoPreview(value: unknown): Promise<GetHostVideoPreviewResult>;
  deleteHostVideo(value: unknown): Promise<DeleteHostVideoResult>;
} {
  const { db, bucket } = options;
  const now = options.now ?? (() => new Date());
  const signPreviewUrl =
    options.signPreviewUrl ??
    (async (file, expiresAt) => {
      const [url] = await file.getSignedUrl({ action: "read", expires: expiresAt, version: "v4" });
      return url;
    });
  const deleteObject =
    options.deleteObject ??
    (async (file) => {
      await file.delete({ ignoreNotFound: true });
    });
  const store = new FirestoreGenerationStore({ db, bucket, now });

  function exposedIso(value: unknown): string {
    if (value instanceof Timestamp) return value.toDate().toISOString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string") return value;
    return now().toISOString();
  }

  async function syncSeedStatus(
    partyId: string,
    seedSnap: FirebaseFirestore.DocumentSnapshot,
  ): Promise<FirebaseFirestore.DocumentData | undefined> {
    const seed = seedSnap.data();
    if (!seed || seed.status === "deleted") return seed ?? undefined;
    try {
      const jobSnap = await jobRef(db, partyId, String(seed.jobId)).get();
      if (!jobSnap.exists) return seed;
      const job = jobSnap.data()!;
      const state = String(job.state);
      const next: HostSeedStatus | undefined =
        state === "ready" || state === "delivering" || state === "purged"
          ? "ready"
          : state === "failed" || state === "expired"
            ? "failed"
            : state === "running"
              ? "running"
              : undefined;
      if (next && next !== seed.status) {
        await seedSnap.ref.update({ status: next, updatedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
        return { ...seed, status: next };
      }
      return seed;
    } catch {
      return seed;
    }
  }

  /** Copies delivery bytes to separately referenced preview objects (idempotent). */
  async function ensurePreviewCopies(
    partyId: string,
    seedId: string,
    clips: Array<{ cameraId: string; objectPath: string; sha256: string }>,
    previewExpiresAt: Date,
  ): Promise<string[]> {
    const paths: string[] = [];
    for (const clip of clips) {
      const previewPath = hostPreviewObjectPath(partyId, seedId, clip.cameraId);
      const preview = bucket.file(previewPath);
      const [exists] = await preview.exists().catch(() => [false] as unknown as [boolean]);
      if (!exists) {
        // Deleted seeds must never recreate previews: the caller checks the
        // seed status inside a transaction first; this copy is the
        // materialization step only for live seeds.
        await bucket.file(clip.objectPath).copy(preview);
        await preview
          .setMetadata({
            contentType: "video/mp4",
            customTime: previewExpiresAt.toISOString(),
            metadata: {
              expiresAt: previewExpiresAt.toISOString(),
              partyId,
              seedId,
              jobId: jobIdForHostSeed(seedId),
              cameraId: clip.cameraId,
              purpose: "host-preview",
              sha256: clip.sha256,
            },
          })
          .catch(() => undefined);
      }
      paths.push(previewPath);
    }
    return paths;
  }

  async function deliveryClipsForJob(
    partyId: string,
    channelId: string,
    jobId: string,
  ): Promise<Array<{ cameraId: string; objectPath: string; sha256: string }>> {
    const jobSnap = await jobRef(db, partyId, jobId).get();
    if (!jobSnap.exists) throw new BackendError("NOT_FOUND", "Seed video does not exist.");
    const job = jobSnap.data()!;
    const staged = (job.stagedOutputs ?? {}) as Record<string, { objectPath?: unknown; sha256?: unknown; cameraId?: unknown }>;
    const fromStaged = Object.values(staged).filter(
      (clip): clip is { cameraId: string; objectPath: string; sha256: string } =>
        !!clip && typeof clip.objectPath === "string" && typeof clip.sha256 === "string" && typeof clip.cameraId === "string",
    );
    if (fromStaged.length > 0) return fromStaged;
    // Fall back to the published current manifest when it belongs to this job.
    const current = await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get();
    if (current.exists) {
      const manifest = current.data() as { jobId?: unknown; cameraClips?: unknown };
      if (manifest.jobId === jobId && Array.isArray(manifest.cameraClips)) {
        return (manifest.cameraClips as Array<Record<string, unknown>>)
          .filter((clip) => typeof clip.cameraId === "string" && typeof clip.objectPath === "string" && typeof clip.sha256 === "string")
          .map((clip) => ({ cameraId: clip.cameraId as string, objectPath: clip.objectPath as string, sha256: clip.sha256 as string }));
      }
    }
    throw new BackendError("NOT_FOUND", "Seed video preview is not ready yet.");
  }

  async function listHostVideos(value: unknown): Promise<{ videos: HostSeedEntry[] }> {
    const input = parseListHostVideosInput(value);
    const host = await assertRegisteredHostDevice(db, input);
    const snapshot = await db.collection(`parties/${host.partyId}/seedVideos`).get();
    const videos: HostSeedEntry[] = [];
    for (const doc of snapshot.docs) {
      const seed = doc.data();
      if (seed.partyId !== host.partyId || seed.channelId !== host.channelId) continue;
      const synced = await syncSeedStatus(host.partyId, doc);
      const current = synced ?? seed;
      videos.push({
        seedId: String(seed.seedId),
        partyId: host.partyId,
        channelId: host.channelId,
        status: current.status as HostSeedStatus,
        jobId: String(seed.jobId),
        createdAt: exposedIso(seed.createdAt),
        expiresAt: exposedIso(seed.expiresAt),
        previewAvailable: Array.isArray(seed.previewPaths) && seed.previewPaths.length > 0,
        cameraIds: Array.isArray(seed.cameraIds) ? (seed.cameraIds as string[]) : [...REQUIRED_CAMERA_IDS],
      });
    }
    videos.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { videos };
  }

  async function generateHostVideo(value: unknown): Promise<GenerateHostVideoResult> {
    const input = parseGenerateHostVideoInput(value);
    const host = await assertRegisteredHostDevice(db, input);
    const jobId = jobIdForHostSeed(input.seedId);
    const ref = seedRef(db, host.partyId, input.seedId);
    const existing = await ref.get();
    if (existing.exists) {
      const old = existing.data()!;
      if (
        old.partyId !== host.partyId ||
        old.channelId !== host.channelId ||
        old.jobId !== jobId ||
        old.idempotencyKey !== input.idempotencyKey ||
        old.deviceId !== host.deviceId ||
        (old.guestMediaId ?? undefined) !== (input.guestMediaId ?? undefined) ||
        old.presetId !== input.presetId
      ) {
        throw new BackendError("FORBIDDEN", "seedId is already bound to a different request.");
      }
      const synced = await syncSeedStatus(host.partyId, existing);
      const jobSnap = await jobRef(db, host.partyId, jobId).get();
      return {
        seedId: input.seedId,
        jobId,
        state: jobSnap.exists ? String(jobSnap.data()?.state ?? synced?.status ?? "queued") : String(synced?.status ?? "queued"),
        created: false,
      };
    }
    // Deletion/withdrawal races: a seed id bound to a deleted seed can never
    // be resurrected through generate (tombstone check below is best-effort;
    // the publish path rechecks transactionally).
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + HOST_PREVIEW_TTL_MS);
    await ref.create({
      seedId: input.seedId,
      partyId: host.partyId,
      deviceId: host.deviceId,
      channelId: host.channelId,
      jobId,
      idempotencyKey: input.idempotencyKey,
      presetId: input.presetId,
      ...(input.guestMediaId ? { guestMediaId: input.guestMediaId } : {}),
      status: "queued",
      cameraIds: [...REQUIRED_CAMERA_IDS],
      previewPaths: [],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromDate(expiresAt),
    });
    // Fixed-preset queue with the existing idempotency, budget, and consent
    // checks: host generation is a scoped entry point to the same pipeline,
    // never a parallel one.
    try {
      const request = await store.requestGeneration({
        partyId: host.partyId,
        deviceId: host.deviceId,
        channelId: host.channelId,
        jobId,
        idempotencyKey: input.idempotencyKey,
        presetId: input.presetId,
        ...(input.guestMediaId ? { guestMediaId: input.guestMediaId } : {}),
      });
      await ref.update({ status: request.state === "queued" ? "queued" : request.state, updatedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
      return { seedId: input.seedId, jobId, state: request.state, created: request.created };
    } catch (error) {
      await ref.update({ status: "failed", updatedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
      throw error;
    }
  }

  async function getHostVideoPreview(value: unknown): Promise<GetHostVideoPreviewResult> {
    const input = parseGetHostVideoPreviewInput(value);
    const host = await assertRegisteredHostDevice(db, input);
    const ref = seedRef(db, host.partyId, input.seedId);
    const seedSnap = await ref.get();
    if (!seedSnap.exists) throw new BackendError("NOT_FOUND", "Seed video does not exist.");
    const seed = seedSnap.data()!;
    if (seed.partyId !== host.partyId || seed.channelId !== host.channelId) {
      throw new BackendError("FORBIDDEN", "Seed video is outside the registered party and channel.");
    }
    // A deleted seed never recreates previews.
    if (seed.status === "deleted") throw new BackendError("NOT_FOUND", "Seed video does not exist.");
    const jobSnap = await jobRef(db, host.partyId, String(seed.jobId)).get();
    if (!jobSnap.exists) throw new BackendError("NOT_FOUND", "Seed video does not exist.");
    if (jobSnap.data()?.hostDeleted === true) throw new BackendError("NOT_FOUND", "Seed video does not exist.");
    const clips = await deliveryClipsForJob(host.partyId, host.channelId, String(seed.jobId));
    const previewExpiry = seed.expiresAt instanceof Timestamp
      ? seed.expiresAt.toDate()
      : new Date(Date.parse(String(seed.expiresAt)));
    const previewExpiresAt = Number.isFinite(previewExpiry.getTime())
      ? previewExpiry
      : new Date(now().getTime() + HOST_PREVIEW_TTL_MS);
    const previewPaths = await ensurePreviewCopies(host.partyId, input.seedId, clips, previewExpiresAt);
    await ref.update({ previewPaths, status: "ready", updatedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
    const nowMs = now().getTime();
    // Signed TTL is capped at the preview's own expiry (same pattern as delivery URLs).
    const clipsOut = await Promise.all(
      clips.map(async (clip) => {
        const previewPath = hostPreviewObjectPath(host.partyId, input.seedId, clip.cameraId);
        const expiresAt = new Date(Math.min(nowMs + DELIVERY_URL_TTL_SECONDS * 1000, previewExpiresAt.getTime()));
        return {
          cameraId: clip.cameraId,
          sha256: clip.sha256,
          url: await signPreviewUrl(bucket.file(previewPath), expiresAt),
          expiresAt: expiresAt.toISOString(),
        };
      }),
    );
    return { seedId: input.seedId, expiresAt: previewExpiresAt.toISOString(), clips: clipsOut };
  }

  async function deleteHostVideo(value: unknown): Promise<DeleteHostVideoResult> {
    const input = parseDeleteHostVideoInput(value);
    const host = await assertRegisteredHostDevice(db, input);
    const deletedSeedIds: string[] = [];
    const doomedObjects = new Set<string>();
    const doomedJobs: string[] = [];
    let revokedManifest = false;
    for (const seedId of input.seedIds) {
      const ref = seedRef(db, host.partyId, seedId);
      const outcome = await db.runTransaction(async (transaction) => {
        const seedSnap = await transaction.get(ref);
        if (!seedSnap.exists) throw new BackendError("NOT_FOUND", `Seed video ${seedId} does not exist.`);
        const seed = seedSnap.data()!;
        if (seed.partyId !== host.partyId || seed.channelId !== host.channelId) {
          throw new BackendError("FORBIDDEN", "Seed video is outside the registered party and channel.");
        }
        if (seed.status === "deleted") return { already: true as const, jobId: String(seed.jobId), previews: seed.previewPaths };
        const jobId = String(seed.jobId);
        const jobSnap = await transaction.get(jobRef(db, host.partyId, jobId));
        const job = jobSnap.exists ? jobSnap.data()! : undefined;
        const staged = ((job?.stagedOutputs ?? {}) as Record<string, { objectPath?: unknown }>) ?? {};
        const previews = Array.isArray(seed.previewPaths) ? (seed.previewPaths as unknown[]) : [];
        transaction.update(ref, {
          status: "deleted",
          deletedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        if (jobSnap.exists) {
          // Tombstone the job so a deletion/withdrawal racing the worker can
          // never republish it (publish.ts rechecks this flag
          // transactionally) and so no preview is recreated afterwards.
          transaction.update(jobRef(db, host.partyId, jobId), {
            hostDeleted: true,
            deletedSeedId: seedId,
            timestamp: FieldValue.serverTimestamp(),
          });
        }
        // Revoke an affected current manifest whose job matches this seed.
        return { already: false as const, jobId, previews, staged, seed };
      });
      if (outcome.already) {
        deletedSeedIds.push(seedId);
        for (const path of (outcome.previews ?? []) as unknown[]) {
          if (typeof path === "string" && path.startsWith("parties/")) doomedObjects.add(path);
        }
        continue;
      }
      deletedSeedIds.push(seedId);
      doomedJobs.push(outcome.jobId);
      for (const preview of (outcome.previews ?? []) as unknown[]) {
        if (typeof preview === "string" && preview.startsWith("parties/")) doomedObjects.add(preview);
      }
      for (const clip of Object.values((outcome as { staged: Record<string, { objectPath?: unknown }> }).staged ?? {})) {
        if (clip && typeof clip.objectPath === "string" && clip.objectPath.startsWith("parties/")) {
          doomedObjects.add(clip.objectPath);
        }
      }
      const jobSnap = await jobRef(db, host.partyId, outcome.jobId).get().catch(() => undefined);
      const job = jobSnap?.exists ? jobSnap.data()! : undefined;
      for (const key of ["deliveryPaths", "generatedPaths"] as const) {
        const list = job?.[key];
        if (Array.isArray(list)) {
          for (const item of list) if (typeof item === "string" && item.startsWith("parties/")) doomedObjects.add(item);
        }
      }
    }
    // Revoke affected manifests after the tombstones are durable.
    if (doomedJobs.length > 0) {
      const currentRef = db.doc(`parties/${host.partyId}/manifests/current_${host.channelId}`);
      const current = await currentRef.get().catch(() => undefined);
      if (current?.exists) {
        const manifest = current.data() as Record<string, unknown>;
        if (typeof manifest.jobId === "string" && doomedJobs.includes(manifest.jobId)) {
          const clips = manifest.cameraClips;
          if (Array.isArray(clips)) {
            for (const clip of clips) {
              if (clip && typeof clip === "object" && typeof (clip as Record<string, unknown>).objectPath === "string") {
                const path = (clip as Record<string, unknown>).objectPath as string;
                if (path.startsWith("parties/")) doomedObjects.add(path);
              }
            }
          }
          await currentRef.delete().catch(() => undefined);
          revokedManifest = true;
        }
      }
    }
    const deletedObjects: string[] = [];
    for (const path of doomedObjects) {
      try {
        await deleteObject(bucket.file(path));
        deletedObjects.push(path);
      } catch {
        // Left for the retention sweeper; never counted as deleted.
      }
    }
    deletedObjects.sort();
    // Accounting records (costLogs / usage ledger rows) are intentionally
    // never deleted here.
    return { deletedSeedIds, deletedObjects, revokedManifest };
  }

  return { listHostVideos, generateHostVideo, getHostVideoPreview, deleteHostVideo };
}

/** Publish-gate helper: a tombstoned host job must never publish or re-preview. */
export function isHostDeletedJob(job: FirebaseFirestore.DocumentData): boolean {
  return (job as Record<string, unknown>).hostDeleted === true;
}

export { seedIdForHostJob };
