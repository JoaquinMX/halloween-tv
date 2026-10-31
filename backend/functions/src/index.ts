import { getFunctions } from "firebase-admin/functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { resolve } from "node:path";
import { BackendError } from "./contracts";
import { ErrorCode, isGenerationEnabled, REGION, STORAGE_TRIGGER_REGION } from "./config";
import { getAdminApp, getAdminBucket, getAdminFirestore } from "./firebase";
import { GenerationTask } from "./delivery";
import { createRetentionService } from "./retention";
import { createRuntimeServices, type RuntimeServices } from "./runtime";

setGlobalOptions({ region: REGION, maxInstances: 10 });

const intEnv = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name] ?? String(fallback));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// Lazily-initialized, cached singleton: trigger discovery (require-time)
// must never throw for missing runtime env (e.g. STORAGE_BUCKET). The
// first callable/task/schedule invocation builds the services object and
// every later invocation reuses the SAME cached instance. A callable
// invoked without STORAGE_BUCKET still fails loudly at request time via
// the existing callable() INTERNAL mapping — never silently succeeds.
let cachedServices: RuntimeServices | undefined;
function getServices(): RuntimeServices {
  if (cachedServices) return cachedServices;
  const db = getAdminFirestore();
  const bucket = getAdminBucket();
  const taskQueue = getFunctions(getAdminApp()).taskQueue(`locations/${REGION}/functions/runGeneration`);
  cachedServices = createRuntimeServices({
    db,
    bucket,
    generationEnabled: isGenerationEnabled(),
    enqueueGeneration: async (task) => taskQueue.enqueue(task),
    fixtureDirectory: resolve(__dirname, "../../runtime/fixtures"),
    pollIntervalMs: intEnv("PROVIDER_POLL_INTERVAL_MS", 15_000),
    providerTimeoutMs: intEnv("PROVIDER_TIMEOUT_MS", 12 * 60 * 1000),
  });
  return cachedServices;
}

const httpsCode: Record<ErrorCode, "unauthenticated" | "permission-denied" | "failed-precondition" | "unavailable" | "resource-exhausted" | "invalid-argument" | "not-found" | "internal"> = {
  UNAUTHENTICATED: "unauthenticated",
  FORBIDDEN: "permission-denied",
  MANIFEST_MISMATCH: "failed-precondition",
  CLIP_EXPIRED: "failed-precondition",
  PROVIDER_UNAVAILABLE: "unavailable",
  BUDGET_EXCEEDED: "resource-exhausted",
  INVALID_ARGUMENT: "invalid-argument",
  NOT_FOUND: "not-found",
  INTERNAL: "internal",
};

async function callable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BackendError) {
      throw new HttpsError(httpsCode[error.errorCode], error.message, { errorCode: error.errorCode });
    }
    throw new HttpsError("internal", "The request could not be completed.", { errorCode: "INTERNAL" });
  }
}

/** Anonymous TV callable; party/device registration is the identity boundary. */
export const requestGeneration = onCall({ maxInstances: 2 }, (request) =>
  callable(() => getServices().requestGeneration(request.data)));

/** Internal task queue worker. One attempt only: no billable automatic retries. */
export const runGeneration = onTaskDispatched({
  // Fixed 900s deadline: must equal GENERATION_WORKER_TIMEOUT_SECONDS (default).
  // Preflight compares this literal against the configured env and fails on drift.
  timeoutSeconds: 900,
  retryConfig: { maxAttempts: 1, minBackoffSeconds: 60, maxBackoffSeconds: 60 },
  rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
}, async (request) => { await getServices().runGeneration(request.data as GenerationTask); });

/** Internal pipeline hooks, callable by the worker composition and never an HTTP endpoint. */
export async function normalizeAndStage(...args: Parameters<RuntimeServices["normalizeAndStage"]>) {
  return getServices().normalizeAndStage(...args);
}
export async function publishManifest(...args: Parameters<RuntimeServices["publishManifest"]>) {
  return getServices().publishManifest(...args);
}

/** Anonymous TV callable; URLs are scoped to the registered active party/device. */
export const getDeliveryUrls = onCall({ maxInstances: 10 }, (request) =>
  callable(() => getServices().getDeliveryUrls(request.data)));

/** Anonymous TV callable; returns the validated current manifest as plain JSON. */
export const getCurrentManifest = onCall({ maxInstances: 10 }, (request) =>
  callable(() => getServices().getCurrentManifest(request.data)));

/** Host TV callable; lists registered party devices (guest codes) for verbal dictation. Guests get FORBIDDEN. */
export const listPartyDevices = onCall({ maxInstances: 2 }, (request) =>
  callable(() => getServices().listPartyDevices(request.data)));

/** Anonymous phone callable; self-registers a guest device for the active channel (PIN-gated when configured). */
export const joinParty = onCall({ maxInstances: 10 }, (request) =>
  callable(() => getServices().joinParty(request.data)));

/** Guest photo upload with affirmative server-side consent (no login). */
export const requestGuestUpload = onCall({ maxInstances: 10 }, (request) =>
  callable(() => getServices().requestGuestUpload(request.data)));

/** Guest upload finalization: verifies actual image bytes before eligibility. */
export const completeGuestUpload = onCall({ maxInstances: 10 }, (request) =>
  callable(() => getServices().completeGuestUpload(request.data)));

/** Guest media status for the owning registered device. */
export const getGuestMediaStatus = onCall({ maxInstances: 10 }, (request) =>
  callable(() => getServices().getGuestMediaStatus(request.data)));

/** Idempotent consent withdrawal: revokes eligibility and purges cloud copies. */
export const withdrawGuestMedia = onCall({ maxInstances: 10 }, (request) =>
  callable(() => getServices().withdrawGuestMedia(request.data)));

/** Object-finalization cleanup: a PUT after withdrawal never restores eligibility. */
function ingestBucket(): string {
  const bucket = process.env.STORAGE_BUCKET ?? process.env.FIREBASE_STORAGE_BUCKET;
  if (bucket) return bucket;
  // Require-time safe fallback for discovery/local runs without bucket env.
  // Cloud predeploy gates refuse deploys without an explicit bucket, and the
  // emulator run sets STORAGE_BUCKET explicitly, so this never targets cloud.
  return "demo-halloween-tv.appspot.com";
}
export const onGuestIngestFinalized = onObjectFinalized({ bucket: ingestBucket(), region: STORAGE_TRIGGER_REGION }, async (event) => {
  await getServices().handleGuestIngestFinalized(event.data.name);
});

/** Anonymous TV callable; ACK and purge are idempotent by device/channel/version. */
export const acknowledgeDelivery = onCall({ maxInstances: 10 }, (request) =>
  callable(() => getServices().acknowledgeDelivery(request.data)));

/** Scheduled TTL transition and orphan object sweeper. */
export const sweepExpiredMedia = onSchedule("every 15 minutes", async () => {
  await createRetentionService(getAdminFirestore(), getAdminBucket())();
});

