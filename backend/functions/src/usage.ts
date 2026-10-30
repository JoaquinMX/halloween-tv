import { FieldValue, Firestore } from "firebase-admin/firestore";
import { REQUIRED_CAMERA_IDS } from "./config";
import { CameraId } from "./video_generation_port";

export interface UsageIdentity {
  partyId: string;
  deviceId: string;
  channelId: string;
  manifestVersion: number;
  idempotencyKey: string;
}

export interface UsageLedgerInput extends UsageIdentity {
  jobId: string;
  cameraId: CameraId;
}

export interface UsageOutcome {
  success: boolean;
  secondsOut?: number;
  secondsIn?: number;
  creditsCharged?: number | null;
  providerTaskId?: string | null;
  errorCode?: string;
  /** Locally prepared fixture slot: no provider submission, no provider charge. */
  fixture?: boolean;
}

export function usageLedgerId(jobId: string, cameraId: CameraId): string {
  return `${jobId}_${cameraId}`;
}

export function usageLedgerPath(input: UsageLedgerInput): string {
  return `parties/${input.partyId}/costLogs/${usageLedgerId(input.jobId, input.cameraId)}`;
}

/** Fields match backend-contract-v1; per-camera rows preserve every provider task ID. */
export function usageIntentDocument(input: UsageLedgerInput, timestamp: unknown = FieldValue.serverTimestamp()) {
  return {
    model_id: "wan3.0-video",
    preset_id: "cheap_demo",
    seconds_out: 2,
    seconds_in: 0,
    credits_charged: null,
    provider_task_id: null,
    created_at: timestamp,
    success: false,
    partyId: input.partyId,
    deviceId: input.deviceId,
    channelId: input.channelId,
    manifestVersion: input.manifestVersion,
    timestamp,
    idempotencyKey: input.idempotencyKey,
    jobId: input.jobId,
    cameraId: input.cameraId,
  };
}

export async function recordUsageOutcome(
  db: Firestore,
  input: UsageLedgerInput,
  outcome: UsageOutcome,
): Promise<void> {
  const patch: Record<string, unknown> = {
    success: outcome.success,
    seconds_out: outcome.secondsOut ?? 2,
    seconds_in: outcome.secondsIn ?? 0,
    credits_charged: outcome.creditsCharged ?? null,
    timestamp: FieldValue.serverTimestamp(),
  };
  if (outcome.providerTaskId !== undefined) patch.provider_task_id = outcome.providerTaskId;
  if (outcome.errorCode) patch.errorCode = outcome.errorCode;
  // Fixture slots keep truthful provenance: no fabricated provider task ID or
  // charge. Synthetic provider zero stays on the single generated camera only.
  if (outcome.fixture !== undefined) patch.fixture = outcome.fixture;
  const ref = db.doc(usageLedgerPath(input));
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (!existing.exists) {
      transaction.create(ref, { ...usageIntentDocument(input), ...patch });
    } else {
      transaction.update(ref, patch);
    }
  });
}

export interface UsageReconciliationIssue {
  partyId: string;
  jobId: string;
  cameraId: CameraId;
  code: "MISSING_LEDGER" | "INCOMPLETE_LEDGER" | "MISSING_PROVIDER_TASK_ID" | "TASK_ID_MISMATCH" | "MISSING_SUCCESS_OUTCOME" | "SUBMISSION_OUTCOME_UNKNOWN";
}

/** Read-only consistency check between durable provider attempts and the usage ledger. */
export async function reconcileUsage(db: Firestore): Promise<UsageReconciliationIssue[]> {
  const jobs = await db.collectionGroup("jobs").get();
  const issues: UsageReconciliationIssue[] = [];
  for (const snapshot of jobs.docs) {
    const job = snapshot.data();
    if (job.presetId !== "cheap_demo" || typeof job.partyId !== "string" || typeof job.jobId !== "string") continue;
    const cameraTasks = job.providerTasks && typeof job.providerTasks === "object" ? job.providerTasks as Record<string, Record<string, unknown>> : {};
    const attempts = job.cameraAttempts && typeof job.cameraAttempts === "object" ? job.cameraAttempts as Record<string, Record<string, unknown>> : {};
    for (const cameraId of REQUIRED_CAMERA_IDS) {
      const ledger = await db.doc(`parties/${job.partyId}/costLogs/${usageLedgerId(job.jobId, cameraId)}`).get();
      const taskId = cameraTasks[cameraId]?.taskId;
      const attempt = attempts[cameraId];
      if (!ledger.exists) {
        issues.push({ partyId: job.partyId, jobId: job.jobId, cameraId, code: "MISSING_LEDGER" });
      } else {
        const data = ledger.data()!;
        const requiredFields = ["model_id", "preset_id", "seconds_out", "seconds_in", "credits_charged", "provider_task_id", "created_at", "success", "partyId", "deviceId", "channelId", "manifestVersion", "timestamp", "idempotencyKey"];
        if (requiredFields.some((field) => !(field in data))) {
          issues.push({ partyId: job.partyId, jobId: job.jobId, cameraId, code: "INCOMPLETE_LEDGER" });
        } else if (data.fixture === true && data.provider_task_id === null) {
          // Locally prepared fixture slot in a consent-bound guest job: no
          // provider submission is expected, so task-ID checks do not apply.
        } else if (job.state === "ready" && typeof taskId !== "string") {
          issues.push({ partyId: job.partyId, jobId: job.jobId, cameraId, code: "MISSING_PROVIDER_TASK_ID" });
        } else if (typeof taskId === "string" && data.provider_task_id !== taskId) {
          issues.push({ partyId: job.partyId, jobId: job.jobId, cameraId, code: "TASK_ID_MISMATCH" });
        } else if (typeof taskId === "string" && job.state === "ready" && data.success !== true) {
          issues.push({ partyId: job.partyId, jobId: job.jobId, cameraId, code: "MISSING_SUCCESS_OUTCOME" });
        }
      }
      if (attempt?.submissionState === "submitting" && typeof taskId !== "string") {
        issues.push({ partyId: job.partyId, jobId: job.jobId, cameraId, code: "SUBMISSION_OUTCOME_UNKNOWN" });
      }
    }
  }
  return issues;
}
