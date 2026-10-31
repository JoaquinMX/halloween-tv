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

test("cartoon still-stage ledger reconciles alongside per-camera rows", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const jobId = "job-cartoon-still-ledger";
  const { cartoonStillLedgerPath, cartoonStillIntentDocument, recordCartoonStillOutcome } = await import("../src/usage");
  try {
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set({
      partyId,
      jobId,
      deviceId: "tv-usage",
      channelId: "main",
      manifestVersion: 3,
      idempotencyKey: "idem-cartoon-still",
      presetId: "cheap_demo",
      state: "running",
      cartoonPlan: {
        scenarioId: "attic-computer-corner", situationId: "cramped-stumble-chase",
        stillPlanId: "cartoon-still-plan-01", videoPlanId: "cartoon-video-plan-01", version: 1, seed: 130100,
      },
      cartoonChain: { stillStatus: "completed", stillTaskId: "still_abc123", stillSha256: "c".repeat(64) },
      providerTasks: {},
      cameraAttempts: {},
    });
    // Missing still ledger row is reported (outcome-less intent).
    const missing = await reconcileUsage(db);
    assert.ok(missing.some((issue) => issue.jobId === jobId && issue.code === "MISSING_LEDGER"));
    // Record the still outcome on the resume path; the intent row exists now.
    await db.doc(cartoonStillLedgerPath(partyId, jobId)).set(cartoonStillIntentDocument({
      partyId, deviceId: "tv-usage", channelId: "main", manifestVersion: 3,
      idempotencyKey: "idem-cartoon-still", jobId, cameraId: "CAM-01",
    }));
    await recordCartoonStillOutcome(db, {
      partyId, deviceId: "tv-usage", channelId: "main", manifestVersion: 3,
      idempotencyKey: "idem-cartoon-still", jobId, cameraId: "CAM-01",
    }, { success: true, secondsOut: 0, secondsIn: 0, creditsCharged: null, providerTaskId: "still_abc123" });
    const stillLedger = await db.doc(cartoonStillLedgerPath(partyId, jobId)).get();
    assert.equal(stillLedger.data()?.success, true);
    assert.equal(stillLedger.data()?.credits_charged, null);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("fixture slots in a guest-bound job reconcile without provider task IDs", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const jobId = "job-guest-usage";
  const { recordUsageOutcome } = await import("../src/usage");
  try {
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set({
      partyId,
      jobId,
      deviceId: "tv-usage",
      channelId: "main",
      manifestVersion: 3,
      idempotencyKey: "idem-guest-usage",
      presetId: "cheap_demo",
      state: "ready",
      providerTasks: { "CAM-01": { taskId: "CAM-01__abc123" } },
      cameraAttempts: {},
      guestMedia: { submissionId: "gsub-1", sourceHash: "a".repeat(64), consentRevision: "v1:t" },
    });
    const base = { partyId, deviceId: "tv-usage", channelId: "main", manifestVersion: 3, idempotencyKey: "idem-guest-usage", jobId };
    await recordUsageOutcome(db, { ...base, cameraId: "CAM-01" }, {
      success: true, secondsOut: 2, secondsIn: 0, creditsCharged: 0, providerTaskId: "CAM-01__abc123",
    });
    for (const cameraId of ["CAM-02", "CAM-03", "CAM-04"] as const) {
      await recordUsageOutcome(db, { ...base, cameraId }, {
        success: true, secondsOut: 2, secondsIn: 0, creditsCharged: null, providerTaskId: null, fixture: true,
      });
    }
    assert.deepEqual(await reconcileUsage(db), []);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
