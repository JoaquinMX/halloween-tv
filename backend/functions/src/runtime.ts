import type { Bucket, File } from "@google-cloud/storage";
import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { createDeliveryServices, DeliveryServiceOptions, GenerationTask } from "./delivery";
import { BackendError, DeliveryManifest, isHostSourceConsent, pendingCartoonIntentPath } from "./contracts";
import { assertGuestEligible } from "./guest_media";
import { createGenerationServices, GenerationServiceOptions } from "./generation";
import { createGuestListService } from "./guest_list";
import { createGuestUploadService } from "./guest_upload";
import { createJoinPartyService } from "./join_party";
import { createHostJoinService } from "./host_join";
import { createHostMediaService } from "./host_media";
import { createVideoGenerationProviderFromEnvironment } from "./providers/fake";
import { ImageGenerationPort } from "./image_generation_port";
import { CameraId, ProviderResult, VideoGenerationPort } from "./video_generation_port";

export interface RuntimeServiceOptions {
  db: Firestore;
  bucket: Bucket;
  generationEnabled?: boolean;
  /** Packaged fixture directory for the offline fake provider (deploy artifact
   *  `runtime/fixtures`). Omitted in tests/emulator, where the provider falls
   *  back to its repository-relative default. */
  fixtureDirectory?: string;
  enqueueGeneration?: (task: GenerationTask) => Promise<void>;
  provider?: VideoGenerationPort;
  /** Image-stage provider for the cartoon still (offline fake by default). */
  imageProvider?: ImageGenerationPort;
  now?: () => Date;
  sleep?: GenerationServiceOptions["sleep"];
  pollIntervalMs?: number;
  providerTimeoutMs?: number;
  normalization?: GenerationServiceOptions["normalization"];
  signReadUrl?: DeliveryServiceOptions["signReadUrl"];
  deleteDeliveryObject?: DeliveryServiceOptions["deleteDeliveryObject"];
  /** Emulator-injected guest PUT signer. Production uses v4 signed PUT URLs. */
  signGuestUploadUrl?: (file: File, contentType: string, expiresAt: Date) => Promise<string>;
  deleteGuestObject?: (file: File) => Promise<void>;
}

export interface RuntimeServices {
  requestGeneration(value: unknown): Promise<{ jobId: string; state: string; created: boolean }>;
  requestCartoonFromPortrait(value: unknown): Promise<{ jobId: string; state: string; created: boolean }>;
  runGeneration(task: GenerationTask): Promise<{ jobId: string; state: string; manifestVersion?: number }>;
  normalizeAndStage(partyId: string, jobId: string, cameraId: CameraId, result: ProviderResult): Promise<Record<string, unknown>>;
  publishManifest(partyId: string, jobId: string, idempotencyKey: string): Promise<DeliveryManifest>;
  getCurrentManifest(value: unknown): ReturnType<ReturnType<typeof createDeliveryServices>["getCurrentManifest"]>;
  getDeliveryUrls: ReturnType<typeof createDeliveryServices>["getDeliveryUrls"];
  acknowledgeDelivery: ReturnType<typeof createDeliveryServices>["acknowledgeDelivery"];
  listPartyDevices: ReturnType<typeof createGuestListService>["listPartyDevices"];
  joinParty: ReturnType<typeof createJoinPartyService>["joinParty"];
  createHostInvite: ReturnType<typeof createHostJoinService>["createHostInvite"];
  joinHost: ReturnType<typeof createHostJoinService>["joinHost"];
  revokeHostDevice: ReturnType<typeof createHostJoinService>["revokeHostDevice"];
  listHostVideos: ReturnType<typeof createHostMediaService>["listHostVideos"];
  generateHostVideo: ReturnType<typeof createHostMediaService>["generateHostVideo"];
  getHostVideoPreview: ReturnType<typeof createHostMediaService>["getHostVideoPreview"];
  deleteHostVideo: ReturnType<typeof createHostMediaService>["deleteHostVideo"];
  requestGuestUpload: ReturnType<typeof createGuestUploadService>["requestGuestUpload"];
  completeGuestUpload: ReturnType<typeof createGuestUploadService>["completeGuestUpload"];
  getGuestMediaStatus: ReturnType<typeof createGuestUploadService>["getGuestMediaStatus"];
  withdrawGuestMedia: ReturnType<typeof createGuestUploadService>["withdrawGuestMedia"];
  handleGuestIngestFinalized: ReturnType<typeof createGuestUploadService>["handleIngestFinalized"];
}

/**
 * One composition for exported handlers and emulator tests. Delivery URLs/ACKs
 * use the delivery service, while request and worker paths use the newer
 * generation store and provider pipeline exclusively.
 */
export function createRuntimeServices(options: RuntimeServiceOptions): RuntimeServices {
  // Provider selection is explicit and lazy: a packaged fixture directory never
  // silently forces fake mode over another configured provider. When the
  // configured provider is fake, the packaged directory (or the repository
  // default) backs it; otherwise the provider resolves lazily so module
  // discovery and local tests never require provider credentials.
  const configuredProvider = (process.env.VIDEO_GENERATION_PROVIDER ?? "fake").trim().toLowerCase();
  const provider = options.provider ??
    (configuredProvider === "fake"
      ? createVideoGenerationProviderFromEnvironment(
          options.fixtureDirectory == null || options.fixtureDirectory.trim() === ""
            ? undefined
            : options.fixtureDirectory,
        )
      : undefined);
  // Still-stage wiring fails closed: the production composition never
  // silently substitutes the offline fake. An explicitly injected
  // imageProvider (tests, rehearsal, or the gated Alibaba construction
  // below) is required; otherwise cartoon generation refuses with
  // PROVIDER_UNAVAILABLE instead of billing a live video for a placeholder
  // still. Fake-produced stills are marked fixture:true (see generation.ts)
  // and publish refuses them for non-rehearsal jobs.
  //
  // Live still consumer (cycle-13 fix-3, verified shape): the synchronous
  // Alibaba Token Plan multimodal-generation adapter carries both references
  // as in-process data URIs — no public/signed hosting, no URL resolver hop,
  // so the previous always-throwing resolveImageUrl is gone. The port is
  // constructed only under the same gated config as video (explicit
  // IMAGE_GENERATION_PROVIDER=alibaba plus server-side credentials);
  // otherwise the still stage fails closed with PROVIDER_UNAVAILABLE.
  const configuredImageProvider = (process.env.IMAGE_GENERATION_PROVIDER ?? "").trim().toLowerCase();
  let imageProvider = options.imageProvider;
  if (!imageProvider && configuredImageProvider === "alibaba") {
    try {
      const { AlibabaImageGenerationPort } = require("./providers/alibaba_image") as typeof import("./providers/alibaba_image");
      const apiKey = process.env.ALIBABA_API_KEY ?? "";
      const workspaceId = process.env.ALIBABA_WORKSPACE_ID ?? "";
      if (apiKey && workspaceId) {
        imageProvider = new AlibabaImageGenerationPort({ apiKey, workspaceId });
      }
    } catch {
      imageProvider = undefined;
    }
  }
  const generation = options.generationEnabled === true
    ? createGenerationServices({
      db: options.db,
      bucket: options.bucket,
      provider,
      imageProvider,
      now: options.now,
      sleep: options.sleep,
      pollIntervalMs: options.pollIntervalMs,
      providerTimeoutMs: options.providerTimeoutMs,
      normalization: options.normalization,
      fixtureDirectory: options.fixtureDirectory,
    })
    : undefined;
  const guestList = createGuestListService({ db: options.db });
  const joinPartyService = createJoinPartyService({ db: options.db });
  const hostJoin = createHostJoinService({ db: options.db, ...(options.now ? { now: options.now } : {}) });
  const enqueue = options.enqueueGeneration ?? (async () => {
    throw new BackendError("PROVIDER_UNAVAILABLE", "Generation task queue is not configured.");
  });
  const hostMedia = createHostMediaService({
    db: options.db,
    bucket: options.bucket,
    ...(options.now ? { now: options.now } : {}),
    ...(options.signReadUrl ? { signPreviewUrl: options.signReadUrl } : {}),
    ...(options.deleteDeliveryObject ? { deleteObject: options.deleteDeliveryObject } : {}),
    enqueueGeneration: enqueue,
    generationEnabled: options.generationEnabled === true,
  });
  const guestUpload = createGuestUploadService({
    db: options.db,
    bucket: options.bucket,
    now: options.now,
    ...(options.signGuestUploadUrl ? { signUploadUrl: options.signGuestUploadUrl } : {}),
    ...(options.deleteGuestObject ? { deleteObject: options.deleteGuestObject } : {}),
    // Eligible-upload completion AND ingest-finalization/replay races
    // idempotently enqueue backend-selected two-stage cartoon generation when
    // generation is enabled. Host-source portraits are skipped: the explicit
    // host seed request owns that scope's ONE job/plan, so the auto path
    // never consumes a second job or self-blocks single-flight. Failures
    // propagate so the upload layer can retain pending intent (BUDGET) or
    // mark TERMINAL unavailable (queue admission); upload itself stays
    // operational. Generation-disabled keeps upload fully operational (no
    // hook wired).
    ...(generation ? {
      onPortraitEligible: async (info) => {
        if (info.hostSource) return;
        const request = await generation.requestCartoonFromPortrait({
          partyId: info.partyId,
          deviceId: info.deviceId,
          channelId: info.channelId,
          guestMediaId: info.submissionId,
        });
        if (request.created) {
          const task: GenerationTask = {
            partyId: request.partyId,
            deviceId: request.deviceId,
            channelId: request.channelId,
            jobId: request.jobId,
            idempotencyKey: request.idempotencyKey,
          };
          try {
            await enqueue(task);
          } catch (error) {
            await generation.failEnqueue(task).catch(() => undefined);
            throw new BackendError("PROVIDER_UNAVAILABLE", "Generation task could not be queued.");
          }
        }
      },
    } : {}),
  });
  const delivery = createDeliveryServices({
    db: options.db,
    bucket: options.bucket,
    now: options.now,
    signReadUrl: options.signReadUrl,
    deleteDeliveryObject: options.deleteDeliveryObject,
  });

  /**
   * Bounded pending-intent dispatch (fix-5a): after capacity releases, queue
   * each pending portrait EXACTLY ONCE with its SAME immutable plan (no
   * reroll), before any provider submit. Single-flight stays: the first
   * dispatch occupies the budget and the rest stay pending. Withdrawal/expiry
   * gates are rechecked at dispatch (withdrawn/expired pending never
   * dispatches and is cleaned up). Queue-admission failures mark the intent
   * TERMINAL unavailable. One pass per trigger, no timers, no blind resubmit
   * of unknown outcomes (existing failed jobs are never resubmitted).
   */
  async function flushPendingIntents(partyId: string): Promise<void> {
    if (!generation) return;
    let pending: FirebaseFirestore.QueryDocumentSnapshot[];
    try {
      const snapshot = await options.db.collection(`parties/${partyId}/pendingGenerations`).where("status", "==", "pending").get();
      pending = [...snapshot.docs].sort((a, b) => {
        const at = (d: FirebaseFirestore.DocumentData) => {
          const created = (d as Record<string, unknown>).createdAt;
          if (created && typeof created === "object" && "toDate" in created) {
            try { return (created as { toDate: () => Date }).toDate().getTime(); } catch { return 0; }
          }
          return 0;
        };
        return at(a.data()) - at(b.data());
      });
    } catch {
      return;
    }
    for (const intentDoc of pending) {
      const intent = intentDoc.data() as Record<string, unknown>;
      const submissionId = typeof intent.submissionId === "string" ? intent.submissionId : intentDoc.id;
      const deviceId = typeof intent.deviceId === "string" ? intent.deviceId : "";
      const channelId = typeof intent.channelId === "string" ? intent.channelId : "";
      if (!deviceId || !channelId) {
        await intentDoc.ref.delete().catch(() => undefined);
        continue;
      }
      // Withdrawal/expiry gates re-checked at dispatch.
      let eligible: Awaited<ReturnType<typeof assertGuestEligible>> | undefined;
      try {
        eligible = await assertGuestEligible(
          options.db,
          { partyId, deviceId, channelId },
          String(submissionId),
          (options.now ?? (() => new Date()))().getTime(),
        );
      } catch (error) {
        // Withdrawn/expired pending never dispatches and is cleaned up.
        await intentDoc.ref.delete().catch(() => undefined);
        continue;
      }
      if (eligible.consentRevision !== intent.consentRevision || eligible.sourceHash !== intent.sourceHash) {
        await intentDoc.ref.delete().catch(() => undefined);
        continue;
      }
      if (isHostSourceConsent(eligible.consent?.textVersion, eligible.consent?.purpose)) {
        await intentDoc.ref.delete().catch(() => undefined);
        continue;
      }
      // No blind resubmit: an existing job in any state owns this portrait.
      const jobId = `cartoon-${String(submissionId)}`;
      const jobSnap = await options.db.doc(`parties/${partyId}/jobs/${jobId}`).get().catch(() => undefined);
      if (jobSnap?.exists) {
        const state = String(jobSnap.data()?.state ?? "");
        if (state === "queued" || state === "running") {
          await intentDoc.ref.update({ status: "queued", updatedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
          continue;
        }
        // Terminal (ready/failed/...) jobs are never resubmitted; a failed
        // queue admission is surfaced TERMINAL, otherwise the intent is done.
        if (state === "failed") {
          await intentDoc.ref.update({
            status: "unavailable",
            errorCode: typeof jobSnap.data()?.errorCode === "string" ? jobSnap.data()?.errorCode : "PROVIDER_UNAVAILABLE",
            updatedAt: FieldValue.serverTimestamp(),
          }).catch(() => undefined);
        } else {
          await intentDoc.ref.delete().catch(() => undefined);
        }
        continue;
      }
      try {
        const request = await generation.requestCartoonFromPortrait({
          partyId,
          deviceId,
          channelId,
          guestMediaId: String(submissionId),
        });
        const task: GenerationTask = {
          partyId: request.partyId,
          deviceId: request.deviceId,
          channelId: request.channelId,
          jobId: request.jobId,
          idempotencyKey: request.idempotencyKey,
        };
        // The dispatched retry reuses the SAME immutable plan: verify the
        // persisted plan was not rerolled.
        const job = await options.db.doc(`parties/${partyId}/jobs/${request.jobId}`).get().catch(() => undefined);
        const persistedPlan = job?.exists ? (job.data() as Record<string, unknown>).cartoonPlan : undefined;
        if (persistedPlan !== undefined && intent.plan !== undefined &&
            JSON.stringify(persistedPlan) !== JSON.stringify(intent.plan)) {
          await options.db.doc(`parties/${partyId}/jobs/${request.jobId}`).delete().catch(() => undefined);
          await intentDoc.ref.update({
            status: "unavailable",
            errorCode: "MANIFEST_MISMATCH",
            updatedAt: FieldValue.serverTimestamp(),
          }).catch(() => undefined);
          continue;
        }
        try {
          await enqueue(task);
        } catch {
          await generation.failEnqueue(task).catch(() => undefined);
          await intentDoc.ref.update({
            status: "unavailable",
            errorCode: "PROVIDER_UNAVAILABLE",
            updatedAt: FieldValue.serverTimestamp(),
          }).catch(() => undefined);
          continue;
        }
        await intentDoc.ref.update({
          status: "queued",
          attempts: Number(intent.attempts ?? 0) + 1,
          updatedAt: FieldValue.serverTimestamp(),
        }).catch(() => undefined);
      } catch (error) {
        if (error instanceof BackendError && error.errorCode === "BUDGET_EXCEEDED") {
          // Capacity is still occupied: single-flight stays, rest remain
          // pending for the next lifecycle release.
          return;
        }
        if (error instanceof BackendError && (error.errorCode === "FORBIDDEN" || error.errorCode === "CLIP_EXPIRED" || error.errorCode === "NOT_FOUND")) {
          await intentDoc.ref.delete().catch(() => undefined);
          continue;
        }
        // Unknown outcome: never blind-resubmit; leave pending for operator
        // visibility (the next lifecycle event retries boundedly).
        await intentDoc.ref.update({
          attempts: Number(intent.attempts ?? 0) + 1,
          updatedAt: FieldValue.serverTimestamp(),
        }).catch(() => undefined);
        return;
      }
    }
  }

  async function requestGeneration(value: unknown) {
    if (!generation) throw new BackendError("PROVIDER_UNAVAILABLE", "Generation is not enabled.");
    const request = await generation.requestGeneration(value);
    if (request.created) {
      const task: GenerationTask = {
        partyId: request.partyId,
        deviceId: request.deviceId,
        channelId: request.channelId,
        jobId: request.jobId,
        idempotencyKey: request.idempotencyKey,
      };
      try {
        await enqueue(task);
      } catch {
        await generation.failEnqueue(task);
        await flushPendingIntents(request.partyId).catch(() => undefined);
        throw new BackendError("PROVIDER_UNAVAILABLE", "Generation task could not be queued.");
      }
    }
    return { jobId: request.jobId, state: request.state, created: request.created };
  }

  /**
   * Minimal portrait request (guest does consent + upload only; no prompt /
   * scene / situation UI — the client must not supply a plan). The server
   * selects the scenario + situation (seeded RNG) and enqueues exactly one
   * two-stage cartoon job. Service-level only (not an HTTP callable): the
   * upload-completion and ingest-finalization paths drive it.
   */
  async function requestCartoonFromPortrait(value: unknown) {
    if (!generation) throw new BackendError("PROVIDER_UNAVAILABLE", "Generation is not enabled.");
    const request = await generation.requestCartoonFromPortrait(value);
    if (request.created) {
      const task: GenerationTask = {
        partyId: request.partyId,
        deviceId: request.deviceId,
        channelId: request.channelId,
        jobId: request.jobId,
        idempotencyKey: request.idempotencyKey,
      };
      try {
        await enqueue(task);
      } catch {
        await generation.failEnqueue(task);
        await flushPendingIntents(request.partyId).catch(() => undefined);
        throw new BackendError("PROVIDER_UNAVAILABLE", "Generation task could not be queued.");
      }
    }
    return { jobId: request.jobId, state: request.state, created: request.created };
  }

  async function runGeneration(task: GenerationTask) {
    if (!generation) throw new BackendError("PROVIDER_UNAVAILABLE", "Generation is not enabled.");
    try {
      return await generation.runGeneration(task);
    } finally {
      // Capacity released (ready, failed, or worker release): dispatch
      // pending portraits boundedly. Best-effort; never fails the worker.
      await flushPendingIntents(task.partyId).catch(() => undefined);
    }
  }

  async function normalizeAndStage(partyId: string, jobId: string, cameraId: CameraId, result: ProviderResult) {
    if (!generation) throw new BackendError("PROVIDER_UNAVAILABLE", "Generation is not enabled.");
    return generation.normalizeAndStage(partyId, jobId, cameraId, result);
  }

  async function publishManifest(partyId: string, jobId: string, idempotencyKey: string) {
    if (!generation) throw new BackendError("PROVIDER_UNAVAILABLE", "Generation is not enabled.");
    return generation.publishManifest(partyId, jobId, idempotencyKey);
  }

  async function withdrawGuestMedia(value: unknown) {
    const result = await guestUpload.withdrawGuestMedia(value);
    // Withdrawal releases the party budget: dispatch pending portraits
    // boundedly (the withdrawn pending itself was deleted, never dispatched).
    try {
      const identity = (value ?? {}) as { partyId?: unknown };
      if (typeof identity.partyId === "string" && identity.partyId) {
        await flushPendingIntents(identity.partyId).catch(() => undefined);
      }
    } catch {
      // Best-effort only.
    }
    return result;
  }

  return {
    requestGeneration,
    requestCartoonFromPortrait,
    runGeneration,
    normalizeAndStage,
    publishManifest,
    getCurrentManifest: delivery.getCurrentManifest,
    getDeliveryUrls: delivery.getDeliveryUrls,
    acknowledgeDelivery: delivery.acknowledgeDelivery,
    listPartyDevices: guestList.listPartyDevices,
    joinParty: joinPartyService.joinParty,
    createHostInvite: hostJoin.createHostInvite,
    joinHost: hostJoin.joinHost,
    revokeHostDevice: hostJoin.revokeHostDevice,
    listHostVideos: hostMedia.listHostVideos,
    generateHostVideo: hostMedia.generateHostVideo,
    getHostVideoPreview: hostMedia.getHostVideoPreview,
    deleteHostVideo: hostMedia.deleteHostVideo,
    requestGuestUpload: guestUpload.requestGuestUpload,
    completeGuestUpload: guestUpload.completeGuestUpload,
    getGuestMediaStatus: guestUpload.getGuestMediaStatus,
    withdrawGuestMedia,
    handleGuestIngestFinalized: guestUpload.handleIngestFinalized,
  };
}
