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
import { cartoonStillIntentDocument, recordCartoonStillOutcome, recordUsageOutcome, UsageLedgerInput } from "./usage";
import { createVideoGenerationProviderFromEnvironment, FakeVideoGenerationPort } from "./providers/fake";
import { FakeImageGenerationPort } from "./providers/fake_image";
import {
  buildCameoDemoRequest,
  buildCartoonVideoRequest,
  buildCheapDemoRequest,
  CameraId,
  CartoonPlan,
  GuestImageReference,
  ProviderResult,
  ProviderTaskStatus,
  validateCartoonPlan,
  VideoGenerationPort,
} from "./video_generation_port";
import { CartoonStillRequest, ImageGenerationPort } from "./image_generation_port";
import { buildCartoonMotionPrompt, buildCartoonStillRequest, cartoonStillObjectPath, generateCartoonStill, sha256 as cartoonSha256 } from "./cartoon_pipeline";
import { loadValidatedCatalogs, resolveFunctionsRoot } from "./scenario_catalog";
import { canGenerateFromPortrait, provenanceFromGuestMediaDoc } from "./consent_provenance";
import { cartoonStillLedgerId } from "./usage";

export interface GenerationServiceOptions {
  db: FirebaseFirestore.Firestore;
  bucket: Bucket;
  provider?: VideoGenerationPort;
  /** Image-stage provider for the cartoon still (defaults to the offline fake). */
  imageProvider?: ImageGenerationPort;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  providerTimeoutMs?: number;
  normalization?: NormalizationOptions;
  /** Local fixture directory for consent-bound guest jobs (three fixture slots). */
  fixtureDirectory?: string;
  /** Functions root for the packaged scenario catalog (defaults to resolved root). */
  functionsRoot?: string;
  /**
   * Offline-test override for reference URL signing. Production defaults to
   * the bucket's v4 signed read URL (same machinery as delivery signReadUrl,
   * 15-min TTL). Injected signers must return an https URL and must never
   * persist it; the URL is used in-flight only.
   */
  signReferenceUrl?: (objectPath: string) => Promise<string>;
  /** Override for still-bytes URL resolution (image-stage provider inputs). */
  resolveImageUrl?: (bytes: Uint8Array, contentType: string, digest: string) => Promise<string>;
  /** Override for still first-frame URL signing (video-stage input). */
  signStillUrl?: (objectPath: string) => Promise<string>;
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
  const fixtureDirectory = options.fixtureDirectory;
  const getProvider = () => provider ??= createVideoGenerationProviderFromEnvironment(
    typeof fixtureDirectory === "string" && fixtureDirectory.trim() !== "" ? fixtureDirectory : undefined,
  );
  let rehearsalProvider: FakeVideoGenerationPort | undefined;
  const getRehearsalProvider = () => (rehearsalProvider ??= new FakeVideoGenerationPort(
    options.fixtureDirectory == null || options.fixtureDirectory.trim() === "" ? undefined : options.fixtureDirectory,
  ));
  /**
   * Fake-only rehearsal binding: a job carrying the server-persisted
   * `rehearsalOnly` marker resolves ONLY the offline fake provider,
   * regardless of the deployed/injected provider configuration, and fails
   * closed before any submit when the resolution is not the fake provider.
   * Jobs without the marker resolve lazily through the unchanged default
   * path (so unknown-provider failures keep their exact fail-closed shape).
   */
  const resolveRehearsalProvider = (job: FirebaseFirestore.DocumentData): VideoGenerationPort | undefined => {
    if ((job as Record<string, unknown>).rehearsalOnly !== true) return undefined;
    const fake = getRehearsalProvider();
    if (!(fake instanceof FakeVideoGenerationPort)) {
      throw new BackendError("PROVIDER_UNAVAILABLE", "Rehearsal jobs resolve only the fake provider; refusing a live submission.");
    }
    return fake;
  };
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

  // Worker-submission consent gate: delegates to the namespaced eligibility
  // helper (guest v1/guest_cameo or host host_source_v1/host_source), so
  // host-originated sources pass the same gate as guest sources.
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

  async function pollUntilComplete(
    taskId: string,
    activeProvider: VideoGenerationPort | undefined,
    deadline = now().getTime() + providerTimeoutMs,
  ): Promise<ProviderTaskStatus> {
    // Default-path resolution stays lazy (exactly as before) so unknown or
    // misconfigured providers fail at the same point with the same shape.
    const active = activeProvider ?? getProvider();
    while (true) {
      const status = await active.getStatus(taskId);
      if (status.state === "SUCCEEDED" || status.state === "FAILED") return status;
      if (now().getTime() >= deadline) throw new BackendError("PROVIDER_UNAVAILABLE", "Provider task polling timed out; task ID is retained for reconciliation.");
      await sleep(pollIntervalMs);
    }
  }

  async function pollStillUntilComplete(
    taskId: string,
    imagePort: ImageGenerationPort,
    deadline = now().getTime() + providerTimeoutMs,
  ): Promise<{ state: "SUCCEEDED" | "FAILED"; errorCode?: string; errorMessage?: string }> {
    for (;;) {
      if (typeof imagePort.getStatus !== "function") return { state: "SUCCEEDED" };
      const status = await imagePort.getStatus(taskId);
      if (status.state === "SUCCEEDED") return { state: "SUCCEEDED" };
      if (status.state === "FAILED") return { state: "FAILED", ...(status.errorCode ? { errorCode: status.errorCode } : {}), ...(status.errorMessage ? { errorMessage: status.errorMessage } : {}) };
      if (now().getTime() >= deadline) throw new BackendError("PROVIDER_UNAVAILABLE", "Cartoon still polling timed out; task ID is retained for reconciliation.");
      await sleep(pollIntervalMs);
    }
  }

  /**
   * Two-stage cartoon run: immutable plan persisted at creation is reused
   * idempotently; the still stage resumes without a duplicate billable
   * submit (stillTaskId + completed chain), then the wan3.0-video STANDARD
   * cheap_demo envelope animates that exact still as first_frame on CAM-01
   * with polling + result retrieval; CAM-02..04 are local fixture slots.
   * Per-stage usage rows keep unknown credits truthful (null; synthetic
   * zero only from the offline fake). Signed URLs are in-flight only.
   */
  async function runCartoonGeneration(validTask: GenerationTask) {
    const jobDeadline = now().getTime() + providerTimeoutMs;
    const functionsRoot = options.functionsRoot ?? resolveFunctionsRoot();
    const getImagePort = (): ImageGenerationPort => {
      if (options.imageProvider) return options.imageProvider;
      // No silent fake default in production: fail closed so a live batch
      // never animates an offline placeholder while billing real credits.
      // Callers that explicitly want the offline fixture inject
      // FakeImageGenerationPort (marked fixture:true, refused at publish
      // for non-rehearsal jobs).
      throw new BackendError("PROVIDER_UNAVAILABLE", "Cartoon image provider is not configured.");
    };
    try {
      let job = await store.getJob(validTask.partyId, validTask.jobId);
      const plan = job.cartoonPlan as CartoonPlan | undefined;
      if (!plan) throw new BackendError("INVALID_ARGUMENT", "Cartoon job is missing its immutable plan.");
      validateCartoonPlan(plan);
      const rehearsal = (job as Record<string, unknown>).rehearsalOnly === true;
      const activeVideo: VideoGenerationPort | undefined = rehearsal ? getRehearsalProvider() : undefined;
      const imagePort = rehearsal
        ? (getRehearsalImagePort() as ImageGenerationPort)
        : getImagePort();
      const stillIsFixture = imagePort instanceof FakeImageGenerationPort;
      const { catalog, situations } = loadValidatedCatalogs(functionsRoot);
      // Portrait bytes: consent-bound submission when the plan cites one.
      const portraitSubmissionId = typeof plan.portraitSubmissionId === "string" ? plan.portraitSubmissionId : undefined;
      let portraitBytes: Uint8Array | undefined;
      let portraitSha: string | undefined;
      let portraitConsentRevision: string | undefined;
      if (portraitSubmissionId !== undefined) {
        const eligible = await assertGuestEligible(options.db, {
          partyId: validTask.partyId, deviceId: validTask.deviceId, channelId: validTask.channelId,
        }, portraitSubmissionId, now().getTime());
        const [bytes] = await options.bucket.file(eligible.objectPath).download().catch(() => [undefined] as unknown as [Buffer | undefined]);
        if (!bytes || bytes.byteLength <= 0) {
          throw new BackendError("MANIFEST_MISMATCH", "Cartoon portrait bytes are not available for generation.");
        }
        if (createHash("sha256").update(bytes).digest("hex") !== eligible.sourceHash) {
          throw new BackendError("MANIFEST_MISMATCH", "Cartoon portrait bytes do not match the consented source hash.");
        }
        // p3 generation gate over plain data: only guest_mobile provenance
        // with the full binding may generate; budget/role/markers never grant.
        const docSnap = await options.db.doc(`parties/${validTask.partyId}/guestMedia/${portraitSubmissionId}`).get().catch(() => undefined);
        const snapExists = docSnap !== undefined && (docSnap as unknown as { exists: boolean }).exists === true;
        const docData = snapExists
          ? (docSnap as unknown as { data: () => Record<string, unknown> }).data()
          : { ...(eligible as unknown as Record<string, unknown>) };
        const provenance = provenanceFromGuestMediaDoc(docData, "server:guest_upload", now().toISOString());
        if (!canGenerateFromPortrait(provenance, {
          partyId: validTask.partyId, channelId: validTask.channelId, deviceId: validTask.deviceId, nowMs: now().getTime(),
        })) {
          throw new BackendError("FORBIDDEN", "Portrait-derived generation is not consented for this scope.");
        }
        portraitBytes = new Uint8Array(bytes);
        portraitSha = eligible.sourceHash;
        portraitConsentRevision = eligible.consentRevision;
      } else {
        throw new BackendError("INVALID_ARGUMENT", "Cartoon plan requires a consent-bound portrait submission.");
      }

      // Stage 1: still (resume without duplicate billable submit).
      job = await store.getJob(validTask.partyId, validTask.jobId);
      let chain = (job.cartoonChain ?? {}) as Record<string, unknown>;
      let stillSha: string | undefined = typeof chain.stillSha256 === "string" ? chain.stillSha256 as string : undefined;
      let stillPath: string | undefined = typeof chain.stillPath === "string" ? chain.stillPath as string : undefined;
      let stillImageBytes: Uint8Array | undefined;
      if (chain.stillStatus === "completed" && stillSha && stillPath) {
        const [persisted] = await options.bucket.file(stillPath).download().catch(() => [undefined] as unknown as [Buffer | undefined]);
        if (!persisted || persisted.byteLength === 0) {
          throw new BackendError("MANIFEST_MISMATCH", "Persisted cartoon still is unavailable.");
        }
        if (createHash("sha256").update(persisted).digest("hex") !== stillSha) {
          throw new BackendError("MANIFEST_MISMATCH", "Persisted cartoon still does not match its recorded hash.");
        }
        stillImageBytes = new Uint8Array(persisted);
        // Resume-without-resubmit still completes the stage: record the
        // still-ledger outcome so the intent row is never left outcome-less.
        await recordCartoonStillOutcome(options.db, ledgerInput(job, "CAM-01"), {
          success: true, secondsOut: 0, secondsIn: 0,
          creditsCharged: (job as Record<string, unknown>).cartoonStillCredits === 0 ? 0 : null,
          providerTaskId: typeof chain.stillTaskId === "string" ? chain.stillTaskId as string : null,
        });
      } else {
        const eligibleContentType = portraitSubmissionId !== undefined
          ? (await assertGuestEligible(options.db, {
              partyId: validTask.partyId, deviceId: validTask.deviceId, channelId: validTask.channelId,
            }, portraitSubmissionId, now().getTime())).contentType
          : undefined;
        const portraitContentType = eligibleContentType === "image/png" ? "image/png" as const : "image/jpeg" as const;
        const stillRequest: CartoonStillRequest = buildCartoonStillRequest({
          jobId: validTask.jobId,
          scenarioId: plan.scenarioId,
          situationId: plan.situationId,
          catalog,
          situations,
          portraitBytes: portraitBytes!,
          portraitContentType,
          portraitSha256: portraitSha!,
          functionsRoot,
        });
        const shouldSubmit = await store.beginStillSubmission(validTask.partyId, validTask.jobId);
        let stillTaskId: string | undefined;
        if (!shouldSubmit) {
          job = await store.getJob(validTask.partyId, validTask.jobId);
          chain = (job.cartoonChain ?? {}) as Record<string, unknown>;
          stillTaskId = typeof chain.stillTaskId === "string" ? chain.stillTaskId as string : undefined;
          if (typeof stillTaskId !== "string") {
            throw new BackendError("PROVIDER_UNAVAILABLE", "No durable cartoon still task ID is available; resubmission is disabled.");
          }
          // Reuse path never resubmits: poll + retrieve the durable task.
          const status = await pollStillUntilComplete(stillTaskId, imagePort, jobDeadline);
          if (status.state === "FAILED") {
            await recordCartoonStillOutcome(options.db, ledgerInput(job, "CAM-01"), {
              success: false, providerTaskId: stillTaskId, creditsCharged: null, errorCode: "PROVIDER_UNAVAILABLE",
            });
            throw new BackendError("PROVIDER_UNAVAILABLE", "Cartoon still task failed.");
          }
          if (typeof imagePort.getResult === "function") {
            const reused = await imagePort.getResult(stillTaskId);
            stillImageBytes = reused.image;
            stillSha = cartoonSha256(stillImageBytes);
            // Still-ledger outcome on the resume path (no duplicate submit).
            await recordCartoonStillOutcome(options.db, ledgerInput(job, "CAM-01"), {
              success: true, secondsOut: 0, secondsIn: 0,
              creditsCharged: reused.creditsCharged ?? null,
              providerTaskId: stillTaskId,
            });
          } else {
            throw new BackendError("PROVIDER_UNAVAILABLE", "Cartoon still result is unavailable.");
          }
        } else {
          let submittedTaskId: string;
          let resultImage: Uint8Array;
          let credits: number | null = null;
          if (typeof imagePort.submit === "function" && typeof imagePort.getResult === "function") {
            const submitted = await imagePort.submit(stillRequest);
            await store.recordStillSubmission(validTask.partyId, validTask.jobId, submitted.taskId);
            submittedTaskId = submitted.taskId;
            const status = await pollStillUntilComplete(submittedTaskId, imagePort, jobDeadline);
            if (status.state === "FAILED") {
              await recordCartoonStillOutcome(options.db, ledgerInput(job, "CAM-01"), {
                success: false, providerTaskId: submittedTaskId, creditsCharged: null, errorCode: "PROVIDER_UNAVAILABLE",
              });
              throw new BackendError("PROVIDER_UNAVAILABLE", "Cartoon still task failed.");
            }
            const result = await imagePort.getResult(submittedTaskId);
            resultImage = result.image;
            credits = result.creditsCharged ?? null;
          } else {
            const result = await generateCartoonStill(imagePort, stillRequest);
            resultImage = result.image;
            credits = result.creditsCharged ?? null;
            submittedTaskId = result.taskId;
            await store.recordStillSubmission(validTask.partyId, validTask.jobId, submittedTaskId);
          }
          if (!resultImage!.length) throw new BackendError("PROVIDER_UNAVAILABLE", "Cartoon image provider returned an empty still.");
          stillSha = cartoonSha256(resultImage!);
          stillImageBytes = resultImage!;
          stillPath = cartoonStillObjectPath(validTask.partyId, validTask.jobId);
          await options.bucket.file(stillPath).save(Buffer.from(stillImageBytes), {
            resumable: false,
            metadata: {
              contentType: "image/png",
              metadata: { purpose: "cartoon-still", jobId: validTask.jobId, partyId: validTask.partyId, sha256: stillSha },
            },
          });
          await store.recordStillResult(validTask.partyId, validTask.jobId, stillSha, stillPath,
            portraitSubmissionId, portraitSha, portraitConsentRevision, { stillFixture: stillIsFixture });
          await recordCartoonStillOutcome(options.db, ledgerInput(job, "CAM-01"), {
            success: true, secondsOut: 0, secondsIn: 0, creditsCharged: credits, providerTaskId: submittedTaskId!,
          });
        }
        // Persisted hashed consent-bound still: hash + path bound to the chain.
        if (!stillSha || !stillImageBytes) {
          throw new BackendError("PROVIDER_UNAVAILABLE", "Cartoon still is unavailable.");
        }
        if (!stillPath) {
          stillPath = cartoonStillObjectPath(validTask.partyId, validTask.jobId);
          const [persisted] = await options.bucket.file(stillPath).download().catch(() => [undefined] as unknown as [Buffer | undefined]);
          if (!persisted) {
            await options.bucket.file(stillPath).save(Buffer.from(stillImageBytes), {
              resumable: false,
              metadata: {
                contentType: "image/png",
                metadata: { purpose: "cartoon-still", jobId: validTask.jobId, partyId: validTask.partyId, sha256: stillSha },
              },
            });
          }
          await store.recordStillResult(validTask.partyId, validTask.jobId, stillSha, stillPath,
            portraitSubmissionId, portraitSha, portraitConsentRevision, { stillFixture: stillIsFixture });
        }
      }

      // Stage 2: video from the exact still as first_frame (CAM-01 only).
      // Consent recheck immediately before the billable video submit: a
      // withdrawal that landed after the still stage fails the job closed
      // here so no post-revocation provider spend occurs.
      if (portraitSubmissionId !== undefined) {
        try {
          await assertGuestEligible(options.db, {
            partyId: validTask.partyId, deviceId: validTask.deviceId, channelId: validTask.channelId,
          }, portraitSubmissionId, now().getTime());
        } catch (error) {
          if (error instanceof BackendError && error.errorCode === "FORBIDDEN") {
            await failForWithdrawnConsent(validTask.partyId, validTask.jobId).catch(() => undefined);
          }
          throw error instanceof BackendError && error.errorCode === "FORBIDDEN"
            ? new BackendError("FORBIDDEN", "Guest consent was withdrawn; the bound generation job is discarded.")
            : error;
        }
      }
      const motion = buildCartoonMotionPrompt({ scenarioId: plan.scenarioId, situationId: plan.situationId, catalog, situations });
      const signStill = options.signStillUrl
        ?? (async (objectPath: string) => {
          const [url] = await options.bucket.file(objectPath).getSignedUrl({
            action: "read", version: "v4", expires: new Date(now().getTime() + REFERENCE_READ_URL_TTL_MS),
          });
          return url;
        });
      const stillUrl = await signStill(stillPath!);
      if (typeof stillUrl !== "string" || !/^https:\/\//.test(stillUrl)) {
        throw new BackendError("PROVIDER_UNAVAILABLE", "Cartoon still URL signing did not return a fetchable https URL.");
      }
      const videoRequest = buildCartoonVideoRequest(validTask.jobId, validTask.idempotencyKey, "CAM-01", motion, { url: stillUrl, sha256: stillSha! });
      job = await store.getJob(validTask.partyId, validTask.jobId);
      const stagedCam01 = (job.stagedOutputs ?? {})["CAM-01"] as Record<string, unknown> | undefined;
      if (!stagedCam01) {
        let providerTask = (job.providerTasks ?? {})["CAM-01"] as { taskId?: unknown } | undefined;
        if (!providerTask || typeof providerTask.taskId !== "string") {
          const shouldSubmit = await store.beginSubmission(validTask.partyId, validTask.jobId, "CAM-01");
          if (!shouldSubmit) {
            job = await store.getJob(validTask.partyId, validTask.jobId);
            providerTask = (job.providerTasks ?? {})["CAM-01"] as { taskId?: unknown } | undefined;
          } else {
            const submitted = await (activeVideo ?? getProvider()).submit(videoRequest);
            await store.recordSubmission(validTask.partyId, validTask.jobId, "CAM-01", submitted.taskId);
            providerTask = { taskId: submitted.taskId };
          }
        }
        if (typeof providerTask?.taskId !== "string") {
          throw new BackendError("PROVIDER_UNAVAILABLE", "No durable provider task ID is available; resubmission is disabled.");
        }
        await store.heartbeat(validTask.partyId, validTask.jobId);
        const status = await pollUntilComplete(providerTask.taskId, activeVideo, jobDeadline);
        if (status.state === "FAILED") {
          await recordUsageOutcome(options.db, ledgerInput(job, "CAM-01"), {
            success: false, providerTaskId: providerTask.taskId, creditsCharged: null, errorCode: "PROVIDER_UNAVAILABLE",
          });
          throw new BackendError("PROVIDER_UNAVAILABLE", "Provider task failed.");
        }
        const result = await (activeVideo ?? getProvider()).getResult(providerTask.taskId);
        const staged = await normalizeAndStage(validTask.partyId, validTask.jobId, "CAM-01", result);
        await store.recordCameraResult(validTask.partyId, validTask.jobId, "CAM-01", result, status, staged);
        await recordUsageOutcome(options.db, ledgerInput(job, "CAM-01"), {
          success: true, secondsOut: result.secondsOut, secondsIn: result.secondsIn,
          creditsCharged: result.creditsCharged, providerTaskId: providerTask.taskId,
        });
        await store.recordCartoonVideoStaged(validTask.partyId, validTask.jobId, stillSha!);
      }
      // Three fixture slots (never billable): CAM-02..04 local fixtures.
      for (const cameraId of REQUIRED_CAMERA_IDS) {
        if (cameraId === "CAM-01") continue;
        const current = await store.getJob(validTask.partyId, validTask.jobId);
        if ((current.stagedOutputs ?? {})[cameraId]) {
          await recordUsageOutcome(options.db, ledgerInput(current, cameraId), {
            success: true, secondsOut: 2, secondsIn: 0, creditsCharged: null, providerTaskId: null, fixture: true,
          });
          continue;
        }
        const staged = await stageFixtureSlot(validTask.partyId, validTask.jobId, cameraId);
        await store.recordFixtureResult(validTask.partyId, validTask.jobId, cameraId, staged, 2);
        await recordUsageOutcome(options.db, ledgerInput(current, cameraId), {
          success: true, secondsOut: 2, secondsIn: 0, creditsCharged: null, providerTaskId: null, fixture: true,
        });
      }
      const finished = await store.getJob(validTask.partyId, validTask.jobId);
      await publish(validTask.partyId, validTask.jobId, validTask.idempotencyKey);
      return { jobId: validTask.jobId, state: "ready", manifestVersion: Number(finished.manifestVersion) };
    } catch (error) {
      const latest = await store.getJob(validTask.partyId, validTask.jobId).catch(() => undefined);
      if (latest && !["failed", "ready"].includes(String(latest.state))) {
        await store.releaseWorker(validTask.partyId, validTask.jobId).catch(() => undefined);
      }
      throw error;
    }
  }

  function getRehearsalImagePort(): ImageGenerationPort {
    let cached: ImageGenerationPort | undefined;
    return (cached ??= new FakeImageGenerationPort());
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
    // Cartoon jobs take the two-stage still-to-video path (immutable plan,
    // one generated CAM-01 + three fixture slots); all other jobs keep the
    // existing cheap_demo/cameo_demo path byte-for-byte.
    if ((claim.job as Record<string, unknown>).cartoonPlan !== undefined) {
      return runCartoonGeneration(validTask);
    }
    // Rehearsal-marked jobs bind to the fake provider before any submit;
    // unmarked jobs keep `undefined` so every default-path call site resolves
    // lazily through getProvider() exactly as before.
    const activeProvider = resolveRehearsalProvider(claim.job);
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
              result = await (activeProvider ?? getProvider()).getResult(providerTask.taskId);
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
              const submitted = await (activeProvider ?? getProvider()).submit(request);
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
          status = await pollUntilComplete(providerTask.taskId, activeProvider, jobDeadline);
        } catch (error) {
          await store.releaseWorker(validTask.partyId, validTask.jobId);
          throw error;
        }
        if (status.state === "FAILED") {
          // Surface the provider's failure reason in the worker error and on
          // the job doc (truncated, sanitized — no credentials/URLs) so the
          // next diagnosis does not need a manual API query. Empty reasons
          // keep the legacy generic mapping.
          const rawCode = typeof status.errorCode === "string" ? status.errorCode : "";
          const rawMessage = typeof status.errorMessage === "string" ? status.errorMessage : "";
          const sanitizedMessage = rawMessage
            .replace(/https?:\/\/\S+/gi, "[url]")
            .replace(/wss?:\/\/\S+/gi, "[url]")
            .replace(/gs:\/\/\S+/gi, "[url]")
            .replace(/Bearer\s+[A-Za-z0-9._~+/_=-]+/gi, "Bearer [redacted]")
            .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
            .replace(/[\u0000-\u001f\u007f]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 280);
          const detail = [rawCode, sanitizedMessage].map((part) => part.trim()).filter(Boolean).join(": ");
          const persistable = detail ? detail.slice(0, 280) : "PROVIDER_FAILED";
          await store.recordProviderFailure({ ...validTask, presetId: jobPresetId }, cameraId, persistable);
          await recordUsageOutcome(options.db, ledgerInput(job, cameraId), {
            success: false,
            providerTaskId: providerTask.taskId,
            creditsCharged: null,
            errorCode: "PROVIDER_UNAVAILABLE",
          });
          if (detail) {
            throw new BackendError("PROVIDER_UNAVAILABLE", `Provider task failed (${detail.slice(0, 280)}).`);
          }
          throw new BackendError("PROVIDER_UNAVAILABLE", "Provider task failed.");
        }
        let result: ProviderResult;
        try {
          result = await (activeProvider ?? getProvider()).getResult(providerTask.taskId);
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

