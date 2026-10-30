import type { Bucket } from "@google-cloud/storage";
import type { Firestore } from "firebase-admin/firestore";
import { createDeliveryServices, DeliveryServiceOptions, GenerationTask } from "./delivery";
import { BackendError, DeliveryManifest } from "./contracts";
import { createGenerationServices, GenerationServiceOptions } from "./generation";
import { createGuestListService } from "./guest_list";
import { FakeVideoGenerationPort } from "./providers/fake";
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
}

/**
 * One composition for exported handlers and emulator tests. Delivery URLs/ACKs
 * use the delivery service, while request and worker paths use the newer
 * generation store and provider pipeline exclusively.
 */
export function createRuntimeServices(options: RuntimeServiceOptions): RuntimeServices {
  const provider = options.provider ??
    (options.fixtureDirectory == null || options.fixtureDirectory.trim() === ""
      ? undefined
      : new FakeVideoGenerationPort(options.fixtureDirectory));
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
    })
    : undefined;
  const guestList = createGuestListService({ db: options.db });
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
  };
}
