import assert from "node:assert/strict";
import test from "node:test";
import { usageIntentDocument, usageLedgerId, reconcileUsage } from "../src/usage";
import { HAS_FIRESTORE_EMULATOR, clearParty, createEmulatorContext, disposeEmulatorContext, randomPartyId } from "./support/emulators";

test("usage intent contains every backend-contract cost and requester field", () => {
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  const input = {
    partyId: "party",
    deviceId: "tv",
    channelId: "main",
    manifestVersion: 2,
    idempotencyKey: "idem",
    jobId: "job",
    cameraId: "CAM-01" as const,
  };
  const row = usageIntentDocument(input, timestamp);
  assert.equal(row.model_id, "wan3.0-video");
  assert.equal(row.preset_id, "cheap_demo");
  assert.equal(row.seconds_out, 2);
  assert.equal(row.seconds_in, 0);
  assert.equal(row.credits_charged, null);
  assert.equal(row.provider_task_id, null);
  assert.equal(row.created_at, timestamp);
  assert.equal(row.success, false);
  assert.equal(row.partyId, input.partyId);
  assert.equal(row.deviceId, input.deviceId);
  assert.equal(row.channelId, input.channelId);
  assert.equal(row.manifestVersion, input.manifestVersion);
  assert.equal(row.timestamp, timestamp);
  assert.equal(row.idempotencyKey, input.idempotencyKey);
  assert.equal(usageLedgerId("job", input.cameraId), "job_CAM-01");
});

test("usage reconciliation reports missing rows, task ID mismatches, and uncertain submissions", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const jobId = "job-usage-reconcile";
  try {
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set({
      partyId,
      jobId,
      deviceId: "tv-usage",
      channelId: "main",
      manifestVersion: 1,
      idempotencyKey: "idem-usage",
      presetId: "cheap_demo",
      providerTasks: { "CAM-01": { taskId: "task-cam-01" } },
      cameraAttempts: { "CAM-02": { consumedAttempt: true, submissionState: "submitting" } },
    });
    await db.doc(`parties/${partyId}/costLogs/${usageLedgerId(jobId, "CAM-01")}`).set({
      ...usageIntentDocument({
        partyId,
        deviceId: "tv-usage",
        channelId: "main",
        manifestVersion: 1,
        idempotencyKey: "idem-usage",
        jobId,
        cameraId: "CAM-01",
      }),
      provider_task_id: "stale-task-id",
    });
    const issues = await reconcileUsage(db);
    assert.deepEqual(issues.map((issue) => `${issue.cameraId}:${issue.code}`).sort(), [
      "CAM-01:TASK_ID_MISMATCH",
      "CAM-02:MISSING_LEDGER",
      "CAM-02:SUBMISSION_OUTCOME_UNKNOWN",
      "CAM-03:MISSING_LEDGER",
      "CAM-04:MISSING_LEDGER",
    ]);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
