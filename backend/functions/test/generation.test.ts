import assert from "node:assert/strict";
import test from "node:test";
import { createGenerationServices } from "../src/generation";
import { REQUIRED_CAMERA_IDS } from "../src/config";
import { BackendError } from "../src/contracts";
import { FakeVideoGenerationPort } from "../src/providers/fake";
import { ProviderResult, ProviderTaskStatus, VideoGenerationRequest } from "../src/video_generation_port";
import { reconcileUsage, usageLedgerId } from "../src/usage";
import { buildCheapDemoRequest, validateCheapDemoControls } from "../src/video_generation_port";
import {
  HAS_FIRESTORE_EMULATOR,
  clearParty,
  createEmulatorContext,
  disposeEmulatorContext,
  randomPartyId,
  seedParty,
} from "./support/emulators";

function expectCode(work: () => unknown, code: string): void {
  assert.throws(work, (error: unknown) => error instanceof BackendError && error.errorCode === code);
}

test("cheap_demo generation request is fixed to one Singapore 480P silent output", () => {
  const request = buildCheapDemoRequest("job-1", "idem-1", "CAM-01");
  assert.equal(request.modelId, "wan3.0-video");
  assert.equal(request.region, "singapore");
  assert.equal(request.resolution, "480P");
  assert.equal(request.secondsOut, 2);
  assert.equal(request.aspectRatio, "16:9");
  assert.equal(request.audio, false);
  assert.equal(request.outputs, 1);
  assert.equal(request.autoUpscale, false);
  expectCode(() => validateCheapDemoControls({ presetId: "cheap_demo", modelId: "another-model" }), "INVALID_ARGUMENT");
  expectCode(() => validateCheapDemoControls({ presetId: "cheap_demo", resolution: "720P" }), "INVALID_ARGUMENT");
  expectCode(() => validateCheapDemoControls({ presetId: "cheap_demo", secondsOut: 5 }), "INVALID_ARGUMENT");
  expectCode(() => validateCheapDemoControls({ presetId: "cheap_demo", outputs: 2 }), "INVALID_ARGUMENT");
  expectCode(() => validateCheapDemoControls({ presetId: "cheap_demo", audio: true }), "INVALID_ARGUMENT");
  expectCode(() => validateCheapDemoControls({ presetId: "cheap_demo", media: [{ type: "image" }] }), "INVALID_ARGUMENT");
});

test("crash reconciliation never repeats an unpersisted billable submission", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  let submissions = 0;
  const provider = {
    async submit(_request: VideoGenerationRequest) { submissions += 1; return { taskId: "should-not-be-submitted" }; },
    async getStatus(_taskId: string): Promise<ProviderTaskStatus> { return { state: "SUCCEEDED" }; },
    async getResult(_taskId: string): Promise<ProviderResult> {
      return { video: { kind: "file", value: "unused" }, secondsOut: 2, secondsIn: 0, creditsCharged: 0 };
    },
  };
  const deviceId = "tv-crash-recovery";
  const channelId = "main";
  const jobId = "job-uncertain-submit";
  const idempotencyKey = "idem-uncertain-submit";
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const services = createGenerationServices({ db, bucket, provider });
    await services.requestGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo" });
    await db.doc(`parties/${partyId}/jobs/${jobId}`).update({
      "cameraAttempts.CAM-01.consumedAttempt": true,
      "cameraAttempts.CAM-01.submissionState": "submitting",
    });
    await assert.rejects(services.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "PROVIDER_UNAVAILABLE");
    assert.equal(submissions, 0);
    const job = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data();
    assert.equal(job?.state, "running");
    assert.equal(job?.status, "reconciliation_required");
    assert.equal(job?.errorCode, "PROVIDER_UNAVAILABLE");
    assert.equal(job?.reconciliationReason, "SUBMISSION_OUTCOME_UNKNOWN");
    const budget = (await db.doc(`parties/${partyId}/generationBudget/active`).get()).data();
    assert.equal(budget?.state, "in_flight");
    await assert.rejects(services.requestGeneration({
      partyId,
      deviceId,
      channelId,
      jobId: "job-blocked-by-uncertain-submit",
      idempotencyKey: "idem-blocked-by-uncertain-submit",
      presetId: "cheap_demo",
    }), (error: unknown) => error instanceof BackendError && error.errorCode === "BUDGET_EXCEEDED");
    assert.ok((await reconcileUsage(db)).some((issue) => issue.code === "SUBMISSION_OUTCOME_UNKNOWN"));
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("registered anonymous request runs fake provider through normalization and atomic publish", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-pilot";
  const channelId = "main";
  const jobId = "job-generation-e2e";
  const idempotencyKey = "idem-generation-e2e";
  try {
    await seedParty(db, partyId, deviceId, channelId);
    await db.doc(`parties/${partyId}/manifests/current_${channelId}`).set({ version: 7 });
    const services = createGenerationServices({
      db,
      bucket,
      provider: new FakeVideoGenerationPort(),
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    const input = { partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo" };
    const request = await services.requestGeneration(input);
    assert.equal(request.state, "queued");
    assert.equal(request.created, true);
    assert.equal(request.manifestVersion, 8);
    assert.ok(request.timestamp);
    const duplicate = await services.requestGeneration(input);
    assert.equal(duplicate.created, false);
    await assert.rejects(services.requestGeneration({ ...input, jobId: "job-budget-guard", idempotencyKey: "idem-budget-guard" }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "BUDGET_EXCEEDED");
    await assert.rejects(services.requestGeneration({ ...input, partyId: "unregistered-party", jobId: "job-unregistered" }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");

    const run = await services.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey });
    assert.deepEqual(run, { jobId, state: "ready", manifestVersion: 8 });
    const repeated = await services.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey });
    assert.equal(repeated.state, "ready");

    const manifest = (await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get()).data()!;
    assert.equal(manifest.version, 8);
    assert.equal(manifest.cameraClips.length, 4);
    assert.deepEqual(manifest.cameraClips.map((clip: { cameraId: string }) => clip.cameraId), [...REQUIRED_CAMERA_IDS]);
    for (const cameraId of REQUIRED_CAMERA_IDS) {
      const ledger = (await db.doc(`parties/${partyId}/costLogs/${usageLedgerId(jobId, cameraId)}`).get()).data()!;
      assert.equal(ledger.partyId, partyId);
      assert.equal(ledger.deviceId, deviceId);
      assert.equal(ledger.channelId, channelId);
      assert.equal(ledger.manifestVersion, 8);
      assert.equal(ledger.idempotencyKey, idempotencyKey);
      assert.equal(ledger.success, true);
      assert.equal(ledger.provider_task_id.startsWith(`${cameraId}__`), true);
    }
    assert.deepEqual(await reconcileUsage(db), []);
    const budget = (await db.doc(`parties/${partyId}/generationBudget/active`).get()).data();
    assert.equal(budget?.state, "idle");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("rehearsalOnly marker binds the worker to the fake provider when live is configured", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  /** Live-shaped stand-in: any submit reaching it would be billable work. */
  class LiveSpyProvider {
    submissions = 0;
    async submit(_request: VideoGenerationRequest) {
      this.submissions += 1;
      return { taskId: "live-billable-task-1" };
    }
    async getStatus(_taskId: string): Promise<ProviderTaskStatus> { return { state: "SUCCEEDED" }; }
    async getResult(_taskId: string): Promise<ProviderResult> {
      return { video: { kind: "file", value: "unused" }, secondsOut: 2, secondsIn: 0, creditsCharged: 9 };
    }
  }
  const deviceId = "tv-rehearsal";
  const channelId = "main";
  const jobId = "job-rehearsal-marker";
  const idempotencyKey = "idem-rehearsal-marker";
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const live = new LiveSpyProvider();
    const services = createGenerationServices({
      db,
      bucket,
      provider: live,
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    const request = await services.requestGeneration({
      partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo", rehearsalOnly: true,
    });
    assert.equal(request.created, true);
    assert.equal((await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()?.rehearsalOnly, true);
    const run = await services.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey });
    assert.equal(run.state, "ready");
    assert.equal(live.submissions, 0, "a rehearsal-marked job must never reach the live provider");
    for (const cameraId of REQUIRED_CAMERA_IDS) {
      const ledger = (await db.doc(`parties/${partyId}/costLogs/${usageLedgerId(jobId, cameraId)}`).get()).data()!;
      assert.match(ledger.provider_task_id, new RegExp(`^${cameraId}__[a-f0-9]{24}$`));
      assert.equal(ledger.credits_charged, 0);
    }
    assert.deepEqual(await reconcileUsage(db), []);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("rehearsalOnly marker is validated, bound to the job, and optional", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-marker";
  const channelId = "main";
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const services = createGenerationServices({
      db,
      bucket,
      provider: new FakeVideoGenerationPort(),
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    const base = { partyId, deviceId, channelId, jobId: "job-marker", idempotencyKey: "idem-marker", presetId: "cheap_demo" };
    await assert.rejects(services.requestGeneration({ ...base, rehearsalOnly: "true" }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "INVALID_ARGUMENT");
    await assert.rejects(services.requestGeneration({ ...base, rehearsalOnly: false }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "INVALID_ARGUMENT");
    const marked = await services.requestGeneration({ ...base, rehearsalOnly: true });
    assert.equal(marked.created, true);
    assert.equal((await db.doc(`parties/${partyId}/jobs/job-marker`).get()).data()?.rehearsalOnly, true);
    const repeat = await services.requestGeneration({ ...base, rehearsalOnly: true });
    assert.equal(repeat.created, false);
    // The same job cannot be re-requested as an unmarked (live-path) job.
    await assert.rejects(services.requestGeneration(base),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");
    const status = await services.getGenerationStatus({ ...base, rehearsalOnly: true });
    assert.equal(status.jobId, "job-marker");
    // Run the marked job to release the party budget: the default path then stays marker-free.
    const run = await services.runGeneration({ partyId, deviceId, channelId, jobId: "job-marker", idempotencyKey: "idem-marker" });
    assert.equal(run.state, "ready");
    await services.requestGeneration({ partyId, deviceId, channelId, jobId: "job-default", idempotencyKey: "idem-default", presetId: "cheap_demo" });
    assert.equal((await db.doc(`parties/${partyId}/jobs/job-default`).get()).data()?.rehearsalOnly, undefined);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("request idempotency cannot be rebound to another device", { skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "tv-1", "main");
    await seedParty(db, partyId, "tv-2", "main");
    const services = createGenerationServices({ db, bucket, provider: new FakeVideoGenerationPort() });
    const input = { partyId, deviceId: "tv-1", channelId: "main", jobId: "job-rebind", idempotencyKey: "idem-rebind", presetId: "cheap_demo" };
    await services.requestGeneration(input);
    await assert.rejects(services.requestGeneration({ ...input, deviceId: "tv-2" }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
