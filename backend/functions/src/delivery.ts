import { createHash } from "node:crypto";
import { Bucket, File } from "@google-cloud/storage";
import { FieldValue, Firestore, Timestamp } from "firebase-admin/firestore";
import {
  AckInput,
  ackIdempotencyKey,
  BackendError,
  CanonicalClip,
  CurrentManifestInput,
  DeliveryManifest,
  Identity,
  canonicalManifestHash,
  parseAck,
  parseCurrentManifestInput,
  parseRequestGeneration,
  RequestGenerationInput,
  requireIdentity,
  validateCanonicalClips,
} from "./contracts";
import {
  CHEAP_DEMO_PRESET,
  DELIVERY_URL_TTL_SECONDS,
  MEDIA_RETENTION_MS,
  REQUIRED_CAMERA_IDS,
  SCHEMA_VERSION,
} from "./config";
import { assertRegisteredPartyDevice } from "./auth";

export interface GeneratedClipInput {
  cameraId: string;
  sourcePath: string;
  sha256: string;
  durationMs: number;
  sizeBytes: number;
}

export interface GenerationTask {
  partyId: string;
  deviceId: string;
  channelId: string;
  jobId: string;
  idempotencyKey: string;
}

export interface DeliveryServiceOptions {
  db: Firestore;
  bucket: Bucket;
  enqueueGeneration?: (task: GenerationTask) => Promise<void>;
  generationRunner?: (job: FirebaseFirestore.DocumentData) => Promise<void>;
  signReadUrl?: (file: File, expiresAt: Date) => Promise<string>;
  deleteDeliveryObject?: (file: File) => Promise<void>;
  now?: () => Date;
}

export interface DeliveryServices {
  requestGeneration(value: unknown): Promise<{ jobId: string; state: string; created: boolean }>;
  runGeneration(task: GenerationTask): Promise<{ jobId: string; state: string }>;
  normalizeAndStage(jobId: string, clips: GeneratedClipInput[]): Promise<DeliveryManifest>;
  publishManifest(jobId: string, idempotencyKey: string): Promise<DeliveryManifest>;
  getCurrentManifest(value: unknown): Promise<SerializedDeliveryManifest>;
  getDeliveryUrls(value: unknown): Promise<{ manifestVersion: number; manifestHash: string; clips: Array<{ cameraId: string; sha256: string; url: string; expiresAt: string }> }>;
  acknowledgeDelivery(value: unknown): Promise<{ ackId: string; manifestVersion: number; purged: boolean }>;
}

export interface SerializedDeliveryManifest extends Omit<DeliveryManifest, "cameraClips" | "createdAt"> {
  cameraClips: Array<Pick<CanonicalClip, "cameraId" | "objectPath" | "sha256" | "sizeBytes" | "durationMs" | "expiresAt">>;
  createdAt: string;
}

const defaultRunner = async (): Promise<void> => {
  // p4 supplies the billable generation adapter. p1 must never make that call.
  throw new BackendError("PROVIDER_UNAVAILABLE", "Generation provider is not configured.");
};

function manifestRef(db: Firestore, partyId: string, channelId: string) {
  return db.doc(`parties/${partyId}/manifests/current_${channelId}`);
}

function jobRef(db: Firestore, partyId: string, jobId: string) {
  return db.doc(`parties/${partyId}/jobs/${jobId}`);
}

function costLogRef(db: Firestore, partyId: string, jobId: string) {
  return db.doc(`parties/${partyId}/costLogs/${jobId}`);
}

function deliveryObjectPath(partyId: string, channelId: string, version: number, cameraId: string): string {
  return `parties/${partyId}/channels/${channelId}/delivery/${version}/${cameraId}.mp4`;
}

function validateDeliveryPath(clip: CanonicalClip, partyId: string, channelId: string, version: number): void {
  if (clip.objectPath !== deliveryObjectPath(partyId, channelId, version, clip.cameraId)) {
    throw new BackendError("MANIFEST_MISMATCH", "Manifest media path is outside its delivery scope.");
  }
}

function manifestFrom(data: FirebaseFirestore.DocumentData | undefined): DeliveryManifest {
  if (!data || !Number.isSafeInteger(data.version) || data.version < 1 ||
      typeof data.partyId !== "string" || typeof data.channelId !== "string" || typeof data.jobId !== "string" ||
      !Number.isSafeInteger(data.schemaVersion) || Number(data.schemaVersion) !== SCHEMA_VERSION ||
      typeof data.expiresAt !== "string" || !Number.isFinite(Date.parse(data.expiresAt))) {
    throw new BackendError("MANIFEST_MISMATCH", "Current manifest is missing or malformed.");
  }
  validateCanonicalClips(data.cameraClips);
  return data as DeliveryManifest;
}

function timestampIso(value: unknown): string {
  let date: Date | undefined;
  if (value instanceof Date) date = value;
  else if (value && typeof value === "object" && "toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
    date = (value as { toDate: () => Date }).toDate();
  } else if (typeof value === "string") {
    const milliseconds = Date.parse(value);
    if (Number.isFinite(milliseconds)) date = new Date(milliseconds);
  }
  if (!date || !Number.isFinite(date.getTime())) {
    throw new BackendError("MANIFEST_MISMATCH", "Published manifest timestamp is missing or malformed.");
  }
  return date.toISOString();
}

function serializeManifest(manifest: DeliveryManifest): SerializedDeliveryManifest {
  for (const clip of manifest.cameraClips) validateDeliveryPath(clip, manifest.partyId, manifest.channelId, manifest.version);
  return {
    partyId: manifest.partyId,
    channelId: manifest.channelId,
    version: manifest.version,
    schemaVersion: manifest.schemaVersion,
    jobId: manifest.jobId,
    cameraClips: manifest.cameraClips.map((clip) => ({
      cameraId: clip.cameraId,
      objectPath: clip.objectPath,
      sha256: clip.sha256,
      sizeBytes: clip.sizeBytes,
      durationMs: clip.durationMs,
      expiresAt: new Date(Date.parse(clip.expiresAt)).toISOString(),
    })),
    createdAt: timestampIso(manifest.createdAt),
    expiresAt: new Date(Date.parse(manifest.expiresAt)).toISOString(),
  };
}

function canonicalClipsMatch(manifest: DeliveryManifest, ack: AckInput): void {
  if (manifest.version !== ack.manifestVersion || manifest.partyId !== ack.partyId || manifest.channelId !== ack.channelId) {
    throw new BackendError("MANIFEST_MISMATCH", "ACK does not match the current party, channel, and manifest version.");
  }
  for (const clip of manifest.cameraClips) {
    if (ack.clipHashes[clip.cameraId] !== clip.sha256) {
      throw new BackendError("MANIFEST_MISMATCH", "ACK hash does not match the canonical manifest.");
    }
    validateDeliveryPath(clip, manifest.partyId, manifest.channelId, manifest.version);
  }
}

export function createDeliveryServices(options: DeliveryServiceOptions): DeliveryServices {
  const { db, bucket } = options;
  const now = options.now ?? (() => new Date());
  const enqueueGeneration = options.enqueueGeneration ?? (async () => undefined);
  const generationRunner = options.generationRunner ?? defaultRunner;
  const signReadUrl = options.signReadUrl ?? (async (file, expiresAt) => {
    const [url] = await file.getSignedUrl({ action: "read", expires: expiresAt, version: "v4" });
    return url;
  });
  const deleteDeliveryObject = options.deleteDeliveryObject ?? (async (file) => {
    await file.delete({ ignoreNotFound: true });
  });

  async function requestGeneration(value: unknown) {
    const input: RequestGenerationInput = parseRequestGeneration(value);
    const registered = await assertRegisteredPartyDevice(db, input);
    const ref = jobRef(db, input.partyId, input.jobId);
    const result = await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) {
        const old = existing.data()!;
        if (old.idempotencyKey !== input.idempotencyKey || old.deviceId !== input.deviceId || old.channelId !== input.channelId) {
          throw new BackendError("FORBIDDEN", "jobId is already bound to a different request.");
        }
        return { state: String(old.state), created: false };
      }
      const inFlight = await transaction.get(
        db.collection(`parties/${input.partyId}/jobs`).where("state", "in", ["queued", "running"]),
      );
      if (!inFlight.empty) throw new BackendError("BUDGET_EXCEEDED", "One generation is already in flight for this party.");
      const currentManifest = await transaction.get(manifestRef(db, input.partyId, input.channelId));
      const sourceManifestVersion = currentManifest.exists ? Number(currentManifest.data()?.version ?? 0) : 0;
      const timestamp = FieldValue.serverTimestamp();
      const expiresAt = Timestamp.fromDate(new Date(now().getTime() + MEDIA_RETENTION_MS));
      transaction.create(ref, {
        jobId: input.jobId,
        partyId: input.partyId,
        deviceId: input.deviceId,
        channelId: input.channelId,
        manifestVersion: sourceManifestVersion,
        state: "queued",
        timestamp,
        createdAt: timestamp,
        idempotencyKey: input.idempotencyKey,
        presetId: CHEAP_DEMO_PRESET.presetId,
        modelId: CHEAP_DEMO_PRESET.modelId,
        costEstimate: { modelId: CHEAP_DEMO_PRESET.modelId, presetId: CHEAP_DEMO_PRESET.presetId, secondsOut: 2 },
        expiresAt,
      });
      transaction.create(costLogRef(db, input.partyId, input.jobId), {
        model_id: CHEAP_DEMO_PRESET.modelId,
        preset_id: CHEAP_DEMO_PRESET.presetId,
        seconds_out: CHEAP_DEMO_PRESET.secondsOut,
        seconds_in: 0,
        credits_charged: 0,
        provider_task_id: null,
        created_at: timestamp,
        success: false,
        partyId: input.partyId,
        deviceId: input.deviceId,
        channelId: input.channelId,
        manifestVersion: sourceManifestVersion,
        timestamp,
        idempotencyKey: input.idempotencyKey,
      });
      return { state: "queued", created: true };
    });
    if (result.created) {
      try {
        await enqueueGeneration({
          partyId: input.partyId,
          deviceId: input.deviceId,
          channelId: input.channelId,
          jobId: input.jobId,
          idempotencyKey: input.idempotencyKey,
        });
      } catch {
        await db.runTransaction(async (transaction) => {
          transaction.update(ref, { state: "failed", errorCode: "PROVIDER_UNAVAILABLE", updatedAt: FieldValue.serverTimestamp() });
          transaction.update(costLogRef(db, input.partyId, input.jobId), { success: false });
        });
        throw new BackendError("PROVIDER_UNAVAILABLE", "Generation task could not be queued.");
      }
    }
    return { jobId: input.jobId, state: result.state, created: result.created };
  }

  async function runGeneration(task: GenerationTask) {
    const identity: Identity = { partyId: task.partyId, deviceId: task.deviceId, channelId: task.channelId };
    await assertRegisteredPartyDevice(db, identity);
    const ref = jobRef(db, task.partyId, task.jobId);
    const claimed = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Generation job does not exist.");
      const job = snapshot.data()!;
      if (job.idempotencyKey !== task.idempotencyKey || job.deviceId !== task.deviceId || job.channelId !== task.channelId) {
        throw new BackendError("FORBIDDEN", "Task identity does not match the job.");
      }
      if (job.state !== "queued") return { run: false, state: String(job.state), job };
      transaction.update(ref, { state: "running", startedAt: FieldValue.serverTimestamp(), timestamp: FieldValue.serverTimestamp() });
      return { run: true, state: "running", job };
    });
    if (!claimed.run) return { jobId: task.jobId, state: claimed.state };
    try {
      await generationRunner(claimed.job);
    } catch (error) {
      const errorCode = error instanceof BackendError ? error.errorCode : "PROVIDER_UNAVAILABLE";
      await db.runTransaction(async (transaction) => {
        transaction.update(ref, { state: "failed", errorCode, failedAt: FieldValue.serverTimestamp(), timestamp: FieldValue.serverTimestamp() });
        transaction.update(costLogRef(db, task.partyId, task.jobId), { success: false, errorCode });
      });
      throw new BackendError(errorCode, "Generation did not complete.");
    }
    return { jobId: task.jobId, state: "running" };
  }

  async function normalizeAndStage(jobId: string, inputs: GeneratedClipInput[]): Promise<DeliveryManifest> {
    const validJobId = jobId;
    const matching = await db.collectionGroup("jobs").where("jobId", "==", validJobId).limit(1).get();
    if (matching.empty) throw new BackendError("NOT_FOUND", "Generation job does not exist.");
    const jobDocument = matching.docs[0];
    const job = jobDocument.data();
    if (job.state !== "running") throw new BackendError("MANIFEST_MISMATCH", "Only a running job can stage generated media.");
    const { partyId, channelId } = job as { partyId: string; channelId: string };
    if (!Array.isArray(inputs) || inputs.length !== REQUIRED_CAMERA_IDS.length) {
      throw new BackendError("MANIFEST_MISMATCH", "Staging requires the four canonical camera clips.");
    }
    const byCamera = new Map(inputs.map((clip) => [clip.cameraId, clip]));
    if (byCamera.size !== inputs.length || REQUIRED_CAMERA_IDS.some((id) => !byCamera.has(id))) {
      throw new BackendError("MANIFEST_MISMATCH", "Staging camera set is invalid.");
    }
    const version = Number(job.manifestVersion ?? 0) + 1;
    const expiresAt = new Date(now().getTime() + MEDIA_RETENTION_MS).toISOString();
    const canonical: CanonicalClip[] = [];
    for (const cameraId of REQUIRED_CAMERA_IDS) {
      const input = byCamera.get(cameraId)!;
      const generatedPrefix = `parties/${partyId}/generated/${validJobId}/`;
      if (!input.sourcePath.startsWith(generatedPrefix) || input.sourcePath.includes("..") || input.sourcePath.includes("\\")) {
        throw new BackendError("MANIFEST_MISMATCH", "Generated media source path is outside its job scope.");
      }
      if (input.durationMs !== 2000 || !/^[a-f0-9]{64}$/.test(input.sha256)) {
        throw new BackendError("MANIFEST_MISMATCH", "Generated clip metadata is invalid.");
      }
      const source = bucket.file(input.sourcePath);
      const [contents] = await source.download();
      const actualHash = createHash("sha256").update(contents).digest("hex");
      if (actualHash !== input.sha256 || contents.byteLength !== input.sizeBytes) {
        throw new BackendError("MANIFEST_MISMATCH", "Generated clip content does not match its metadata.");
      }
      const objectPath = deliveryObjectPath(partyId, channelId, version, cameraId);
      const destination = bucket.file(objectPath);
      await source.copy(destination);
      await destination.setMetadata({
        contentType: "video/mp4",
        customTime: expiresAt,
        metadata: { expiresAt, jobId: validJobId, partyId, channelId, cameraId, purpose: "delivery" },
      });
      canonical.push({ cameraId, objectPath, sha256: actualHash, sizeBytes: contents.byteLength, durationMs: 2000, expiresAt });
    }
    const staged: DeliveryManifest = {
      partyId,
      channelId,
      version,
      schemaVersion: SCHEMA_VERSION,
      jobId: validJobId,
      cameraClips: canonical,
      expiresAt,
    };
    validateCanonicalClips(staged.cameraClips);
    await jobDocument.ref.update({ stagedManifest: staged, deliveryPaths: canonical.map((clip) => clip.objectPath), stagedAt: FieldValue.serverTimestamp() });
    return staged;
  }

  async function publishManifest(jobId: string, idempotencyKey: string): Promise<DeliveryManifest> {
    const matching = await db.collectionGroup("jobs").where("jobId", "==", jobId).limit(1).get();
    if (matching.empty) throw new BackendError("NOT_FOUND", "Generation job does not exist.");
    const ref = matching.docs[0].ref;
    return db.runTransaction(async (transaction) => {
      const jobSnapshot = await transaction.get(ref);
      const job = jobSnapshot.data();
      if (!job || job.idempotencyKey !== idempotencyKey) throw new BackendError("FORBIDDEN", "Publish idempotency key does not match the job.");
      if (job.publishedManifest) return job.publishedManifest as DeliveryManifest;
      const staged = manifestFrom(job.stagedManifest);
      const currentRef = manifestRef(db, job.partyId, job.channelId);
      const currentSnapshot = await transaction.get(currentRef);
      const currentVersion = currentSnapshot.exists ? Number(currentSnapshot.data()?.version ?? 0) : 0;
      if (currentVersion !== Number(job.manifestVersion ?? 0)) {
        throw new BackendError("MANIFEST_MISMATCH", "Current manifest changed while this job was running.");
      }
      const published: DeliveryManifest = { ...staged, createdAt: FieldValue.serverTimestamp() };
      transaction.set(currentRef, published);
      transaction.update(ref, {
        state: "ready",
        manifestVersion: staged.version,
        publishedManifest: staged,
        readyAt: FieldValue.serverTimestamp(),
        timestamp: FieldValue.serverTimestamp(),
      });
      transaction.update(costLogRef(db, job.partyId, jobId), { manifestVersion: staged.version });
      return published;
    });
  }

  async function getDeliveryUrls(value: unknown) {
    const identity = requireIdentity(value);
    if (!identity.channelId) throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
    const registered = await assertRegisteredPartyDevice(db, identity);
    const snapshot = await manifestRef(db, registered.partyId, registered.channelId).get();
    const manifest = manifestFrom(snapshot.data());
    const nowMs = now().getTime();
    const manifestExpiry = Date.parse(manifest.expiresAt);
    if (!Number.isFinite(manifestExpiry) || manifestExpiry <= nowMs) throw new BackendError("CLIP_EXPIRED", "Current manifest has expired.");
    const manifestHash = canonicalManifestHash(manifest);
    const clips = await Promise.all(manifest.cameraClips.map(async (clip) => {
      validateDeliveryPath(clip, manifest.partyId, manifest.channelId, manifest.version);
      const clipExpiry = Date.parse(clip.expiresAt);
      if (!Number.isFinite(clipExpiry) || clipExpiry <= nowMs) throw new BackendError("CLIP_EXPIRED", "A canonical camera clip has expired.");
      const expiresAt = new Date(Math.min(nowMs + DELIVERY_URL_TTL_SECONDS * 1000, clipExpiry));
      return {
        cameraId: clip.cameraId,
        sha256: clip.sha256,
        url: await signReadUrl(bucket.file(clip.objectPath), expiresAt),
        expiresAt: expiresAt.toISOString(),
      };
    }));
    return { manifestVersion: manifest.version, manifestHash, clips };
  }

  async function getCurrentManifest(value: unknown): Promise<SerializedDeliveryManifest> {
    const input: CurrentManifestInput = parseCurrentManifestInput(value);
    const registered = await assertRegisteredPartyDevice(db, input);
    if (registered.channel.status !== "active") throw new BackendError("FORBIDDEN", "Channel is not active for this party.");
    const snapshot = await manifestRef(db, registered.partyId, registered.channelId).get();
    if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Current manifest does not exist.");
    const manifest = manifestFrom(snapshot.data());
    if (manifest.partyId !== registered.partyId || manifest.channelId !== registered.channelId) {
      throw new BackendError("MANIFEST_MISMATCH", "Current manifest is outside the registered party and channel.");
    }
    const currentTimeMs = now().getTime();
    if (Date.parse(manifest.expiresAt) <= currentTimeMs ||
        manifest.cameraClips.some((clip) => Date.parse(clip.expiresAt) <= currentTimeMs)) {
      throw new BackendError("CLIP_EXPIRED", "Current manifest has expired.");
    }
    return serializeManifest(manifest);
  }

  async function acknowledgeDelivery(value: unknown) {
    const ack = parseAck(value);
    await assertRegisteredPartyDevice(db, ack);
    const mRef = manifestRef(db, ack.partyId, ack.channelId);
    const idem = ackIdempotencyKey(ack.deviceId, ack.channelId, ack.manifestVersion);
    const ackId = idem;
    const ackRef = db.doc(`parties/${ack.partyId}/deliveryAcks/${ackId}`);
    const accepted = await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(ackRef);
      if (existing.exists) return validateAcceptedAck(existing.data(), ack, ackId, idem);

      const current = await transaction.get(mRef);
      const manifest = manifestFrom(current.data());
      canonicalClipsMatch(manifest, ack);
      const currentTime = now().getTime();
      if (Date.parse(manifest.expiresAt) <= currentTime || manifest.cameraClips.some((clip) => Date.parse(clip.expiresAt) <= currentTime)) {
        throw new BackendError("CLIP_EXPIRED", "Cannot acknowledge an expired manifest.");
      }
      const relatedJobRef = jobRef(db, ack.partyId, manifest.jobId);
      const relatedJob = await transaction.get(relatedJobRef);
      const acceptedAck = {
        ackId,
        partyId: ack.partyId,
        deviceId: ack.deviceId,
        channelId: ack.channelId,
        manifestVersion: ack.manifestVersion,
        manifestHash: canonicalManifestHash(manifest),
        clipHashes: ack.clipHashes,
        jobId: manifest.jobId,
        clips: manifest.cameraClips.map(({ cameraId, objectPath, sha256 }) => ({ cameraId, objectPath, sha256 })),
        timestamp: FieldValue.serverTimestamp(),
        idempotencyKey: idem,
      };
      transaction.create(ackRef, acceptedAck);
      if (relatedJob.exists && ["ready", "delivering"].includes(String(relatedJob.data()?.state))) {
        transaction.update(relatedJobRef, { state: "delivering", deliveryAckId: ackId, timestamp: FieldValue.serverTimestamp() });
      }
      return validateAcceptedAck(acceptedAck, ack, ackId, idem);
    });
    const relatedJobRef = jobRef(db, ack.partyId, accepted.jobId);
    // ACK is idempotent. Repeating it safely retries object deletion after partial failures.
    await Promise.all(accepted.clips.map((clip) => deleteDeliveryObject(bucket.file(clip.objectPath))));
    await db.runTransaction(async (transaction) => {
      const relatedJob = await transaction.get(relatedJobRef);
      if (relatedJob.exists && relatedJob.data()?.deliveryAckId === ackId) {
        transaction.update(relatedJobRef, { state: "purged", purgedAt: FieldValue.serverTimestamp(), timestamp: FieldValue.serverTimestamp() });
      }
    });
    return { ackId, manifestVersion: ack.manifestVersion, purged: true };
  }

  return { requestGeneration, runGeneration, normalizeAndStage, publishManifest, getCurrentManifest, getDeliveryUrls, acknowledgeDelivery };
}

interface AcceptedAckClip {
  cameraId: (typeof REQUIRED_CAMERA_IDS)[number];
  objectPath: string;
  sha256: string;
}

interface ValidatedAcceptedAck {
  jobId: string;
  clips: AcceptedAckClip[];
}

function validateAcceptedAck(
  value: FirebaseFirestore.DocumentData | Record<string, unknown> | undefined,
  ack: AckInput,
  ackId: string,
  idempotencyKey: string,
): ValidatedAcceptedAck {
  const mismatch = (): never => { throw new BackendError("MANIFEST_MISMATCH", "ACK conflicts with the previously accepted delivery ACK."); };
  if (!value || value.ackId !== ackId || value.partyId !== ack.partyId || value.deviceId !== ack.deviceId ||
      value.channelId !== ack.channelId || value.manifestVersion !== ack.manifestVersion ||
      value.idempotencyKey !== idempotencyKey || !/^[a-f0-9]{64}$/.test(String(value.manifestHash ?? "")) ||
      typeof value.jobId !== "string" || !Array.isArray(value.clips) || value.clips.length !== REQUIRED_CAMERA_IDS.length ||
      !value.clipHashes || typeof value.clipHashes !== "object" || Array.isArray(value.clipHashes) ||
      Object.keys(value.clipHashes).sort().join(",") !== [...REQUIRED_CAMERA_IDS].sort().join(",") ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.jobId)) return mismatch();
  for (const cameraId of REQUIRED_CAMERA_IDS) {
    if ((value.clipHashes as Record<string, unknown>)[cameraId] !== ack.clipHashes[cameraId]) return mismatch();
  }
  const byCamera = new Map<string, AcceptedAckClip>();
  for (const raw of value.clips) {
    if (!raw || typeof raw !== "object") return mismatch();
    const clip = raw as Record<string, unknown>;
    if (typeof clip.cameraId !== "string" || !REQUIRED_CAMERA_IDS.includes(clip.cameraId as AcceptedAckClip["cameraId"]) ||
        typeof clip.objectPath !== "string" || typeof clip.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(clip.sha256) ||
        byCamera.has(clip.cameraId)) return mismatch();
    const cameraId = clip.cameraId as AcceptedAckClip["cameraId"];
    if (clip.objectPath !== deliveryObjectPath(ack.partyId, ack.channelId, ack.manifestVersion, cameraId) ||
        clip.sha256 !== ack.clipHashes[cameraId]) return mismatch();
    byCamera.set(cameraId, { cameraId, objectPath: clip.objectPath, sha256: clip.sha256 });
  }
  if (REQUIRED_CAMERA_IDS.some((cameraId) => !byCamera.has(cameraId))) return mismatch();
  return { jobId: String(value.jobId), clips: REQUIRED_CAMERA_IDS.map((cameraId) => byCamera.get(cameraId)!) };
}

