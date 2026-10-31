import type { Bucket, File } from "@google-cloud/storage";
import type { Firestore } from "firebase-admin/firestore";
import { createDeliveryServices, DeliveryServiceOptions, GenerationTask } from "./delivery";
import { BackendError, DeliveryManifest } from "./contracts";
import { createGenerationServices, GenerationServiceOptions } from "./generation";
import { createGuestListService } from "./guest_list";
import { createGuestUploadService } from "./guest_upload";
import { createJoinPartyService } from "./join_party";
import { createHostJoinService } from "./host_join";
import { createHostMediaService } from "./host_media";
import { FakeVideoGenerationPort, createVideoGenerationProviderFromEnvironment } from "./providers/fake";
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
  const generation = options.generationEnabled === true
    ? createGenerationServices({
      db: options.db,
      bucket: options.bucket,
      provider,
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
  const hostMedia = createHostMediaService({
    db: options.db,
    bucket: options.bucket,
    ...(options.now ? { now: options.now } : {}),
    ...(options.signReadUrl ? { signPreviewUrl: options.signReadUrl } : {}),
    ...(options.deleteDeliveryObject ? { deleteObject: options.deleteDeliveryObject } : {}),
  });
  const guestUpload = createGuestUploadService({
    db: options.db,
    bucket: options.bucket,
    now: options.now,
    ...(options.signGuestUploadUrl ? { signUploadUrl: options.signGuestUploadUrl } : {}),
    ...(options.deleteGuestObject ? { deleteObject: options.deleteGuestObject } : {}),
  });
  const delivery = createDeliveryServices({
    db: options.db,
    bucket: options.bucket,
    now: options.now,
    signReadUrl: options.signReadUrl,
    deleteDeliveryObject: options.deleteDeliveryObject,
  });
  const enqueue = options.enqueueGeneration ?? (async () => {
    throw new BackendError("PROVIDER_UNAVAILABLE", "Generation task queue is not configured.");
  });

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
        throw new BackendError("PROVIDER_UNAVAILABLE", "Generation task could not be queued.");
      }
    }
    return { jobId: request.jobId, state: request.state, created: request.created };
  }

  async function runGeneration(task: GenerationTask) {
    if (!generation) throw new BackendError("PROVIDER_UNAVAILABLE", "Generation is not enabled.");
    return generation.runGeneration(task);
  }

  async function normalizeAndStage(partyId: string, jobId: string, cameraId: CameraId, result: ProviderResult) {
    if (!generation) throw new BackendError("PROVIDER_UNAVAILABLE", "Generation is not enabled.");
    return generation.normalizeAndStage(partyId, jobId, cameraId, result);
  }

  async function publishManifest(partyId: string, jobId: string, idempotencyKey: string) {
    if (!generation) throw new BackendError("PROVIDER_UNAVAILABLE", "Generation is not enabled.");
    return generation.publishManifest(partyId, jobId, idempotencyKey);
  }

  return {
    requestGeneration,
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
    listHostVideos: hostMedia.listHostVideos,
    generateHostVideo: hostMedia.generateHostVideo,
    getHostVideoPreview: hostMedia.getHostVideoPreview,
    deleteHostVideo: hostMedia.deleteHostVideo,
    requestGuestUpload: guestUpload.requestGuestUpload,
    completeGuestUpload: guestUpload.completeGuestUpload,
    getGuestMediaStatus: guestUpload.getGuestMediaStatus,
    withdrawGuestMedia: guestUpload.withdrawGuestMedia,
    handleGuestIngestFinalized: guestUpload.handleIngestFinalized,
  };
}
