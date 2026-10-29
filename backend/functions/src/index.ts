import { getFunctions } from "firebase-admin/functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { BackendError } from "./contracts";
import { ErrorCode, REGION } from "./config";
import { getAdminApp, getAdminBucket, getAdminFirestore } from "./firebase";
import { createDeliveryServices, GenerationTask } from "./delivery";
import { createRetentionService } from "./retention";

setGlobalOptions({ region: REGION, maxInstances: 10 });

const db = getAdminFirestore();
const bucket = getAdminBucket();
const taskQueue = getFunctions(getAdminApp()).taskQueue(`locations/${REGION}/functions/runGeneration`);
const services = createDeliveryServices({
  db,
  bucket,
  enqueueGeneration: async (task) => taskQueue.enqueue(task),
});

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
  callable(() => services.requestGeneration(request.data)));

/** Internal task queue worker. One attempt only: no billable automatic retries. */
export const runGeneration = onTaskDispatched({
  retryConfig: { maxAttempts: 1, minBackoffSeconds: 60, maxBackoffSeconds: 60 },
  rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
}, async (request) => { await services.runGeneration(request.data as GenerationTask); });

/** Internal pipeline hooks, callable by the worker composition and never an HTTP endpoint. */
export const normalizeAndStage = services.normalizeAndStage;
export const publishManifest = services.publishManifest;

/** Anonymous TV callable; URLs are scoped to the registered active party/device. */
export const getDeliveryUrls = onCall({ maxInstances: 10 }, (request) =>
  callable(() => services.getDeliveryUrls(request.data)));

/** Anonymous TV callable; ACK and purge are idempotent by device/channel/version. */
export const acknowledgeDelivery = onCall({ maxInstances: 10 }, (request) =>
  callable(() => services.acknowledgeDelivery(request.data)));

/** Scheduled TTL transition and orphan object sweeper. */
export const sweepExpiredMedia = onSchedule("every 15 minutes", async () => {
  await createRetentionService(db, bucket)();
});

