import { Bucket } from "@google-cloud/storage";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FieldValue } from "firebase-admin/firestore";
import { assertRegisteredPartyDevice } from "./auth";
import { BackendError, parseRequestGeneration, RequestGenerationInput, validateId } from "./contracts";
import { CAMEO_DEMO_PRESET, GUEST_PROVIDER_CAMERA_ID, MEDIA_RETENTION_MS, REQUIRED_CAMERA_IDS } from "./config";
import { FirestoreGenerationStore, GenerationTask } from "./generation_store";
import { assertGuestEligible } from "./guest_media";
import { normalizeProviderVideo, NormalizationOptions, removeNormalizedVideo } from "./normalize";
import { publishManifest as commitManifest } from "./publish";
import { AlibabaSubmissionError } from "./providers/alibaba";
import { recordUsageOutcome, UsageLedgerInput } from "./usage";
import { createVideoGenerationProviderFromEnvironment } from "./providers/fake";
import {
  buildCameoDemoRequest,
  buildCheapDemoRequest,
  CameraId,
  GuestImageReference,
  ProviderResult,
  ProviderTaskStatus,
  VideoGenerationPort,
} from "./video_generation_port";

export interface GenerationServiceOptions {
  db: FirebaseFirestore.Firestore;
  bucket: Bucket;
  provider?: VideoGenerationPort;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  providerTimeoutMs?: number;
  normalization?: NormalizationOptions;
  /** Local fixture directory for consent-bound guest jobs (three fixture slots). */
  fixtureDirectory?: string;
  /**
   * Offline-test override for reference URL signing. Production defaults to
   * the bucket's v4 signed read URL (same machinery as delivery signReadUrl,
   * 15-min TTL). Injected signers must return an https URL and must never
   * persist it; the URL is used in-flight only.
   */
  signReferenceUrl?: (objectPath: string) => Promise<string>;
}

/** Short-lived reference read capability: 15-min TTL is plenty for submit. */
export const REFERENCE_READ_URL_TTL_MS = 15 * 60 * 1000;

export interface GenerationServices {
  requestGeneration(value: unknown): ReturnType<FirestoreGenerationStore["requestGeneration"]>;
  getGenerationStatus(value: unknown): ReturnType<FirestoreGenerationStore["getGenerationStatus"]>;
  failEnqueue(task: GenerationTask): Promise<void>;
  runGeneration(task: GenerationTask): Promise<{ jobId: string; state: string; manifestVersion?: number }>;
  normalizeAndStage(partyId: string, jobId: string, cameraId: CameraId, result: ProviderResult): Promise<Record<string, unknown>>;
  publishManifest(partyId: string, jobId: string, idempotencyKey: string): Promise<import("./contracts").DeliveryManifest>;
}

function ledgerInput(job: FirebaseFirestore.DocumentData, cameraId: CameraId): UsageLedgerInput {
  return {
    partyId: String(job.partyId),
    deviceId: String(job.deviceId),
    channelId: String(job.channelId),
    manifestVersion: Number(job.manifestVersion),
    idempotencyKey: String(job.idempotencyKey),
    jobId: String(job.jobId),
    cameraId,
  };
}

/**
 * Signs a short-lived provider-fetchable read URL for a consented guest
 * photo. Same machinery as the delivery signReadUrl default (GCS v4 read
 * signature); the caller keeps the URL in memory for the submit call only.
 */
export async function signReferenceReadUrl(
  bucket: Bucket,
  objectPath: string,
  now: () => Date = () => new Date(),
): Promise<string> {
  const [url] = await bucket.file(objectPath).getSignedUrl({
    action: "read",
    version: "v4",
    expires: new Date(now().getTime() + REFERENCE_READ_URL_TTL_MS),
  });
  return url;
}

export function createGenerationServices(options: GenerationServiceOptions): GenerationServices {
  let provider = options.provider;
  const getProvider = () => provider ??= createVideoGenerationProviderFromEnvironment();
  const store = new FirestoreGenerationStore({ db: options.db, bucket: options.bucket, now: options.now });
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => new Date());
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;
  const providerTimeoutMs = options.providerTimeoutMs ?? 12 * 60 * 1000;

  async function normalizeAndStage(partyId: string, jobId: string, cameraId: CameraId, result: ProviderResult): Promise<Record<string, unknown>> {
    validateId(partyId, "partyId");
    validateId(jobId, "jobId");
    if (!REQUIRED_CAMERA_IDS.includes(cameraId)) throw new BackendError("INVALID_ARGUMENT", "Camera ID is invalid.");
    const job = await store.getJob(partyId, jobId);
    if (job.state !== "running") throw new BackendError("MANIFEST_MISMATCH", "Only a running generation job can stage media.");
    const old = (job.stagedOutputs ?? {})[cameraId];
    if (old && typeof old === "object") return old as Record<string, unknown>;
    const expectedSecondsOut = job.presetId === CAMEO_DEMO_PRESET.presetId ? CAMEO_DEMO_PRESET.secondsOut : 2;
    const normalized = await normalizeProviderVideo(result, { ...options.normalization, expectedSecondsOut });
    const expiresAt = new Date(now().getTime() + MEDIA_RETENTION_MS).toISOString();
    const objectPath = store.plannedObjectPath(job.partyId, job.channelId, Number(job.manifestVersion), cameraId);
    try {
      const bytes = await readFile(normalized.path);
      await options.bucket.file(objectPath).save(bytes, {
        resumable: false,
        metadata: {
          contentType: "video/mp4",
          customTime: expiresAt,
          metadata: {
            expiresAt,
            jobId,
            partyId: job.partyId,
            channelId: job.channelId,
            cameraId,
            purpose: "delivery",
            sha256: normalized.sha256,
          },
        },
      });
      const clip = {
        cameraId,
        objectPath,
        sha256: normalized.sha256,
        sizeBytes: normalized.sizeBytes,
        durationMs: normalized.durationMs,
        expiresAt,
      };
      await store.recordStagedOutput(job.partyId, jobId, cameraId, clip);
      return clip;
    } finally {
      await removeNormalizedVideo(normalized);
    }
  }

  function fixturePathFor(cameraId: CameraId): string {
    const directory = options.fixtureDirectory ?? resolve(process.cwd(), "../../apps/tv_app/assets");
    const index = REQUIRED_CAMERA_IDS.indexOf(cameraId);
    return resolve(directory, `cam${String(index + 1).padStart(2, "0")}.mp4`);
  }

  /**
   * Locally prepared fixture slot for consent-bound guest jobs. No provider
   * submission, no provider task ID, no provider charge: usage is recorded
   * with explicit fixture provenance and a null task ID.
   */
  async function stageFixtureSlot(partyId: string, jobId: string, cameraId: CameraId): Promise<Record<string, unknown>> {
    validateId(partyId, "partyId");
    validateId(jobId, "jobId");
    const job = await store.getJob(partyId, jobId);
    if (job.state !== "running") throw new BackendError("MANIFEST_MISMATCH", "Only a running generation job can stage media.");
    const old = (job.stagedOutputs ?? {})[cameraId];
    if (old && typeof old === "object") return old as Record<string, unknown>;
    const expectedSecondsOut = job.presetId === CAMEO_DEMO_PRESET.presetId ? CAMEO_DEMO_PRESET.secondsOut : 2;
    const normalized = await normalizeProviderVideo(
      { video: { kind: "file", value: fixturePathFor(cameraId) }, secondsOut: expectedSecondsOut, secondsIn: 0, creditsCharged: null },
      { ...options.normalization, expectedSecondsOut },
    );
    const expiresAt = new Date(now().getTime() + MEDIA_RETENTION_MS).toISOString();
    const objectPath = store.plannedObjectPath(job.partyId, job.channelId, Number(job.manifestVersion), cameraId);
    try {
      const bytes = await readFile(normalized.path);
      await options.bucket.file(objectPath).save(bytes, {
        resumable: false,
        metadata: {
          contentType: "video/mp4",
          customTime: expiresAt,
          metadata: {
            expiresAt,
            jobId,
            partyId: job.partyId,
            channelId: job.channelId,
            cameraId,
            purpose: "delivery",
            fixture: "true",
            sha256: normalized.sha256,
          },
        },
      });
      const clip = {
        cameraId,
        objectPath,
        sha256: normalized.sha256,
        sizeBytes: normalized.sizeBytes,
        durationMs: normalized.durationMs,
        expiresAt,
        fixture: true,
      };
      await store.recordStagedOutput(job.partyId, jobId, cameraId, clip);
      return clip;
    } finally {
      await removeNormalizedVideo(normalized);
    }
  }

  /** Fails a consent-bound job closed after withdrawal and cleans staged bytes. */
  async function failForWithdrawnConsent(partyId: string, jobId: string): Promise<never> {
    const job = await store.getJob(partyId, jobId).catch(() => undefined);
    if (job) {
      const staged = ((job.stagedOutputs ?? {}) as Record<string, Record<string, unknown>>) ?? {};
      for (const cameraId of REQUIRED_CAMERA_IDS) {
        const clip = staged[cameraId];
        if (clip && typeof clip.objectPath === "string" && clip.objectPath.startsWith("parties/")) {
          await options.bucket.file(clip.objectPath).delete({ ignoreNotFound: true }).catch(() => undefined);
        }
      }
    }
    await store.failForWithdrawnConsent(partyId, jobId).catch(() => undefined);
    throw new BackendError("FORBIDDEN", "Guest consent was withdrawn; the bound generation job is discarded.");
  }

  async function recheckGuestConsent(
    partyId: string,
    jobId: string,
    deviceId: string,
    channelId: string,
    submissionId: string,
    expectedHash: string,
  ): Promise<GuestImageReference> {
    let eligible: Awaited<ReturnType<typeof assertGuestEligible>>;
    try {
      eligible = await assertGuestEligible(options.db, { partyId, deviceId, channelId }, submissionId, now().getTime());
    } catch {
      await failForWithdrawnConsent(partyId, jobId);
      throw new BackendError("FORBIDDEN", "Guest consent was withdrawn; the bound generation job is discarded.");
    }
    if (eligible.sourceHash !== expectedHash) {
      throw new BackendError("MANIFEST_MISMATCH", "Guest media source changed while the job was running.");
    }
    const [bytes] = await options.bucket.file(eligible.objectPath).download().catch(() => [undefined] as unknown as [Buffer | undefined]);
    if (!bytes || bytes.byteLength <= 0) {
      throw new BackendError("MANIFEST_MISMATCH", "Guest media bytes are not available for generation.");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== eligible.sourceHash) {
      throw new BackendError("MANIFEST_MISMATCH", "Guest media bytes do not match the consented source hash.");
    }
    // Resolve the consented photo to a short-lived signed https read URL for
    // provider submission: same v4 read-signature machinery as delivery
    // signReadUrl, 15-min TTL. The URL lives only in this in-memory
    // reference; it is never written to manifests, logs, or Firestore docs.
    let url: string;
    try {
      url = options.signReferenceUrl
        ? await options.signReferenceUrl(eligible.objectPath)
        : await signReferenceReadUrl(options.bucket, eligible.objectPath, now);
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw new BackendError("PROVIDER_UNAVAILABLE", "Guest reference URL could not be signed for submission.");
    }
    if (typeof url !== "string" || !/^https:\/\//.test(url)) {
      throw new BackendError("PROVIDER_UNAVAILABLE", "Guest reference URL signing did not return a fetchable https URL.");
    }
    return { objectPath: eligible.objectPath, sha256: eligible.sourceHash, consentRevision: eligible.consentRevision, url };
  }

  async function publish(partyId: string, jobId: string, idempotencyKey: string) {
    return commitManifest(store, partyId, jobId, idempotencyKey);
  }

  async function pollUntilComplete(taskId: string, deadline = now().getTime() + providerTimeoutMs): Promise<ProviderTaskStatus> {
    while (true) {
      const status = await getProvider().getStatus(taskId);
      if (status.state === "SUCCEEDED" || status.state === "FAILED") return status;
      if (now().getTime() >= deadline) throw new BackendError("PROVIDER_UNAVAILABLE", "Provider task polling timed out; task ID is retained for reconciliation.");
      await sleep(pollIntervalMs);
    }
  }

  async function runGeneration(task: GenerationTask) {
    const validTask: GenerationTask = {
      partyId: validateId(task.partyId, "partyId"),
      deviceId: validateId(task.deviceId, "deviceId"),
      channelId: validateId(task.channelId, "channelId"),
      jobId: validateId(task.jobId, "jobId"),
      idempotencyKey: validateId(task.idempotencyKey, "idempotencyKey"),
    };
    await assertRegisteredPartyDevice(options.db, validTask);
    const claim = await store.claimWorker(validTask);
    if (!claim.claimed) return { jobId: validTask.jobId, state: String(claim.job.state), manifestVersion: Number(claim.job.manifestVersion) };
    // Per-job locked duration: cheap_demo stays 2s; the STEP 2 cameo batch is
    // 5s on every slot (one provider camera + three padded fixture slots).
    const jobPresetId = claim.job.presetId === CAMEO_DEMO_PRESET.presetId ? CAMEO_DEMO_PRESET.presetId : "cheap_demo";
    const expectedSecondsOut = jobPresetId === CAMEO_DEMO_PRESET.presetId ? CAMEO_DEMO_PRESET.secondsOut : 2;
    // Consent-bound guest execution plan: exactly ONE provider-generated camera
    // slot (CAM-01, bound to the validated guest photo) plus three locally
    // prepared fixture slots. Text-only jobs keep four provider cameras.
    const guestBinding = (claim.job.guestMedia ?? undefined) as {
      submissionId?: unknown; sourceHash?: unknown;
    } | undefined;
    const isGuestJob = typeof guestBinding?.submissionId === "string" && typeof guestBinding?.sourceHash === "string";
    let guestReference: GuestImageReference | undefined;
    if (isGuestJob) {
      guestReference = await recheckGuestConsent(
        validTask.partyId, validTask.jobId, validTask.deviceId, validTask.channelId,
        String(guestBinding?.submissionId), String(guestBinding?.sourceHash),
      );
    }
    // One provider deadline shared by all four sequential camera polls: worst
    // case stays near providerTimeoutMs (plus normalization headroom checked
    // by preflight) instead of multiplying per camera against the task timeout.
    const jobDeadline = now().getTime() + providerTimeoutMs;
    try {
      for (const cameraId of REQUIRED_CAMERA_IDS) {
        let job = await store.getJob(validTask.partyId, validTask.jobId);
        const stagedOutput = (job.stagedOutputs ?? {})[cameraId] as Record<string, unknown> | undefined;
        if (stagedOutput) {
          if (isGuestJob && cameraId !== GUEST_PROVIDER_CAMERA_ID) {
            await recordUsageOutcome(options.db, ledgerInput(job, cameraId), {
              success: true,
              secondsOut: expectedSecondsOut,
              secondsIn: 0,
              creditsCharged: null,
              providerTaskId: null,
              fixture: true,
            });
            continue;
          }
          const providerTask = (job.providerTasks ?? {})[cameraId] as { taskId?: unknown } | undefined;
          if (typeof providerTask?.taskId !== "string") {
            throw new BackendError("PROVIDER_UNAVAILABLE", "Staged camera output has no durable provider task ID.");
          }
          const cameraResult = (job.cameraResults ?? {})[cameraId] as {
            secondsOut?: number; secondsIn?: number; creditsCharged?: number | null; providerState?: string;
          } | undefined;
          if (!cameraResult || cameraResult.providerState !== "SUCCEEDED") {
            let result;
            try {
              result = await getProvider().getResult(providerTask.taskId);
            } catch (error) {
              if (error instanceof BackendError) throw error;
              throw new BackendError("PROVIDER_UNAVAILABLE", `Provider result is unavailable; task ID ${String(providerTask.taskId)} retained for reconciliation.`);
            }
            await store.recordCameraResult(validTask.partyId, validTask.jobId, cameraId, result, { state: "SUCCEEDED" }, stagedOutput);
            await recordUsageOutcome(options.db, ledgerInput(job, cameraId), {
              success: true,
              secondsOut: result.secondsOut,
              secondsIn: result.secondsIn,
              creditsCharged: result.creditsCharged,
              providerTaskId: providerTask.taskId,
            });
          } else {
            await recordUsageOutcome(options.db, ledgerInput(job, cameraId), {
              success: true,
              secondsOut: cameraResult.secondsOut,
              secondsIn: cameraResult.secondsIn,
              creditsCharged: cameraResult.creditsCharged,
              providerTaskId: providerTask.taskId,
            });
          }
          continue;
        }
        let providerTask = (job.providerTasks ?? {})[cameraId] as { taskId?: unknown } | undefined;
        if (isGuestJob && cameraId !== GUEST_PROVIDER_CAMERA_ID) {
          const staged = await stageFixtureSlot(validTask.partyId, validTask.jobId, cameraId);
          await store.recordFixtureResult(validTask.partyId, validTask.jobId, cameraId, staged, expectedSecondsOut);
          await recordUsageOutcome(options.db, ledgerInput(job, cameraId), {
            success: true,
            secondsOut: expectedSecondsOut,
            secondsIn: 0,
            creditsCharged: null,
            providerTaskId: null,
            fixture: true,
          });
          continue;
        }
        if (isGuestJob) {
          // Worker-submission consent gate: a withdrawal that lands while the
          // job runs discards the job and cleans staged bytes instead of
          // submitting a billable request against revoked consent.
          guestReference = await recheckGuestConsent(
            validTask.partyId, validTask.jobId, validTask.deviceId, validTask.channelId,
            String(guestBinding?.submissionId), String(guestBinding?.sourceHash),
          );
        }
        if (!providerTask || typeof providerTask.taskId !== "string") {
          try {
            const shouldSubmit = await store.beginSubmission(validTask.partyId, validTask.jobId, cameraId);
            if (!shouldSubmit) {
              job = await store.getJob(validTask.partyId, validTask.jobId);
              providerTask = (job.providerTasks ?? {})[cameraId] as { taskId?: unknown } | undefined;
            } else {
              const request = jobPresetId === CAMEO_DEMO_PRESET.presetId
                ? buildCameoDemoRequest(validTask.jobId, validTask.idempotencyKey, cameraId, guestReference)
                : buildCheapDemoRequest(validTask.jobId, validTask.idempotencyKey, cameraId, guestReference);
              const submitted = await getProvider().submit(request);
              await store.recordSubmission(validTask.partyId, validTask.jobId, cameraId, submitted.taskId);
              providerTask = { taskId: submitted.taskId };
            }
          } catch (error) {
            const certainty = error instanceof AlibabaSubmissionError ? error.certainty : "unknown";
            const errorCode = "PROVIDER_UNAVAILABLE";
            await store.recordSubmissionFailure({ ...validTask, presetId: jobPresetId }, cameraId, errorCode, certainty);
            await recordUsageOutcome(options.db, ledgerInput(job, cameraId), {
              success: false,
              providerTaskId: null,
              creditsCharged: null,
              errorCode,
            });
            throw new BackendError("PROVIDER_UNAVAILABLE", "Provider submission did not complete safely.");
          }
        }
        if (typeof providerTask?.taskId !== "string") {
          throw new BackendError("PROVIDER_UNAVAILABLE", "No durable provider task ID is available; resubmission is disabled.");
        }
        await store.heartbeat(validTask.partyId, validTask.jobId);
        let status: ProviderTaskStatus;
        try {
          status = await pollUntilComplete(providerTask.taskId, jobDeadline);
        } catch (error) {
          await store.releaseWorker(validTask.partyId, validTask.jobId);
          throw error;
        }
        if (status.state === "FAILED") {
          const errorCode = status.errorCode ?? "PROVIDER_FAILED";
          await store.recordProviderFailure({ ...validTask, presetId: jobPresetId }, cameraId, errorCode);
          await recordUsageOutcome(options.db, ledgerInput(job, cameraId), {
            success: false,
            providerTaskId: providerTask.taskId,
            creditsCharged: null,
            errorCode: "PROVIDER_UNAVAILABLE",
          });
          throw new BackendError("PROVIDER_UNAVAILABLE", "Provider task failed.");
        }
        let result: ProviderResult;
        try {
          result = await getProvider().getResult(providerTask.taskId);
        } catch (error) {
          if (error instanceof BackendError) throw error;
          throw new BackendError("PROVIDER_UNAVAILABLE", `Provider result is unavailable; task ID ${String(providerTask.taskId)} retained for reconciliation.`);
        }
        const staged = await normalizeAndStage(validTask.partyId, validTask.jobId, cameraId, result);
        await store.recordCameraResult(validTask.partyId, validTask.jobId, cameraId, result, status, staged);
        await recordUsageOutcome(options.db, ledgerInput(job, cameraId), {
          success: true,
          secondsOut: result.secondsOut,
          secondsIn: result.secondsIn,
          creditsCharged: result.creditsCharged,
          providerTaskId: providerTask.taskId,
        });
      }
      const job = await store.getJob(validTask.partyId, validTask.jobId);
      await publish(validTask.partyId, validTask.jobId, validTask.idempotencyKey);
      return { jobId: validTask.jobId, state: "ready", manifestVersion: Number(job.manifestVersion) };
    } catch (error) {
      // A withdrawal racing the worker discards the already-running result and
      // cleans staged bytes instead of publishing a revoked cameo.
      if (isGuestJob && error instanceof BackendError && error.errorCode === "FORBIDDEN") {
        const guestNow = await store.getJob(validTask.partyId, validTask.jobId).catch(() => undefined);
        if (guestNow && !["failed", "ready"].includes(String(guestNow.state))) {
          await failForWithdrawnConsent(validTask.partyId, validTask.jobId).catch(() => undefined);
        }
      } else {
        const latest = await store.getJob(validTask.partyId, validTask.jobId).catch(() => undefined);
        if (latest && !["failed", "ready"].includes(String(latest.state))) {
          await store.releaseWorker(validTask.partyId, validTask.jobId).catch(() => undefined);
        }
      }
      throw error;
    }
  }

  return {
    requestGeneration: (value) => store.requestGeneration(value),
    getGenerationStatus: (value) => store.getGenerationStatus(value),
    failEnqueue: (task) => store.failEnqueue(task),
    runGeneration,
    normalizeAndStage,
    publishManifest: publish,
  };
}

