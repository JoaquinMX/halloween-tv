/** Read-only consistency reconciliation. Never updates provider or cost rows. */
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { REQUIRED_CAMERA_IDS } from "../src/config";
import { reconcileUsage, usageLedgerId } from "../src/usage";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function fail(message: string): never { throw new Error(message); }

async function main(): Promise<void> {
  const target = argument("target");
  if (target !== "cloud" && target !== "emulator") fail("Usage reconciliation requires explicit --target=cloud or --target=emulator.");
  const firestoreEmulator = process.env.FIRESTORE_EMULATOR_HOST;
  const storageEmulator = process.env.STORAGE_EMULATOR_HOST;
  if (Boolean(firestoreEmulator) !== Boolean(storageEmulator)) fail("Refusing mixed emulator configuration; both Firestore and Storage emulator targets must be set together.");
  if (target === "emulator" && (!firestoreEmulator || !storageEmulator)) fail("Emulator reconciliation requires both FIRESTORE_EMULATOR_HOST and STORAGE_EMULATOR_HOST.");
  if (target === "cloud" && (firestoreEmulator || storageEmulator)) fail("Cloud reconciliation refuses emulator environment variables.");
  const projectId = argument("project") ?? (target === "cloud" ? undefined : process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT);
  if (!projectId) fail("Cloud reconciliation requires explicit --project=PROJECT.");
  if (target === "cloud" && projectId.startsWith("demo-")) fail("A demo project ID cannot be selected as a cloud target.");

  const app = initializeApp({ projectId }, `reconcile-usage-${Date.now()}`);
  try {
    const db = getFirestore(app);
    const initialIssues = await reconcileUsage(db);
    const jobs = await db.collectionGroup("jobs").get();
    const details: Array<Record<string, unknown>> = [];
    const fieldIssues: Array<Record<string, unknown>> = [];
    const terminalStates = new Set(["ready", "delivering", "purged"]);
    const requiredFields = ["model_id", "preset_id", "seconds_out", "seconds_in", "credits_charged", "provider_task_id", "created_at", "success", "partyId", "deviceId", "channelId", "manifestVersion", "timestamp", "idempotencyKey"];
    for (const jobSnapshot of jobs.docs) {
      const job = jobSnapshot.data();
      if (job.presetId !== "cheap_demo" || typeof job.partyId !== "string" || typeof job.jobId !== "string") continue;
      const tasks = job.providerTasks && typeof job.providerTasks === "object" ? job.providerTasks as Record<string, { taskId?: unknown }> : {};
      for (const cameraId of REQUIRED_CAMERA_IDS) {
        const ledgerSnapshot: FirebaseFirestore.DocumentSnapshot = await db.doc(`parties/${job.partyId}/costLogs/${usageLedgerId(job.jobId, cameraId)}`).get();
        if (!ledgerSnapshot.exists) continue;
        const row: FirebaseFirestore.DocumentData = ledgerSnapshot.data()!;
        const missing = requiredFields.filter((field) => !(field in row));
        if (missing.length) fieldIssues.push({ partyId: job.partyId, jobId: job.jobId, cameraId, code: "INCOMPLETE_LEDGER_FIELDS", fields: missing });
        const identity = { partyId: "partyId", deviceId: "deviceId", channelId: "channelId", manifestVersion: "manifestVersion", idempotencyKey: "idempotencyKey" };
        const mismatched = Object.entries(identity).filter(([jobField, rowField]) => row[rowField] !== job[jobField]).map(([jobField]) => jobField);
        if (row.jobId !== job.jobId || row.cameraId !== cameraId || mismatched.length) {
          fieldIssues.push({ partyId: job.partyId, jobId: job.jobId, cameraId, code: "LEDGER_IDENTITY_MISMATCH", fields: [...mismatched, ...(row.jobId !== job.jobId ? ["jobId"] : []), ...(row.cameraId !== cameraId ? ["cameraId"] : [])] });
        }
        const taskId = tasks[cameraId]?.taskId;
        if (typeof taskId === "string" && row.provider_task_id !== taskId) fieldIssues.push({ partyId: job.partyId, jobId: job.jobId, cameraId, code: "TASK_ID_MISMATCH", taskId, ledgerTaskId: row.provider_task_id });
        if (terminalStates.has(String(job.state)) && (typeof taskId !== "string" || row.success !== true)) {
          fieldIssues.push({ partyId: job.partyId, jobId: job.jobId, cameraId, code: "TERMINAL_OUTCOME_INCOMPLETE", taskId: taskId ?? null, success: row.success });
        }
        const synthetic = typeof taskId === "string" && new RegExp(`^${cameraId}__[a-f0-9]{24}$`).test(taskId) && row.credits_charged === 0;
        details.push({
          partyId: job.partyId,
          jobId: job.jobId,
          state: job.state,
          cameraId,
          providerTaskId: typeof taskId === "string" ? taskId : null,
          ledgerTaskId: row.provider_task_id ?? null,
          success: row.success === true,
          credits: row.credits_charged ?? null,
          creditStatus: row.credits_charged === null || row.credits_charged === undefined
            ? "unknown"
            : synthetic ? "synthetic_zero" : "recorded_value_unverified",
        });
      }
    }
    const issues = [...initialIssues, ...fieldIssues];
    process.stdout.write(`${JSON.stringify({ mode: "read-only", target, projectId, jobCameraCount: details.length, issueCount: issues.length, issues, cameras: details })}\n`);
    if (issues.length) process.exitCode = 2;
  } finally {
    await deleteApp(app);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
