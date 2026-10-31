import assert from "node:assert/strict";
import test from "node:test";
import { createGenerationServices } from "../src/generation";
import { REQUIRED_CAMERA_IDS } from "../src/config";
import { BackendError } from "../src/contracts";
import { FakeVideoGenerationPort } from "../src/providers/fake";
import { ProviderResult, ProviderTaskStatus, VideoGenerationRequest } from "../src/video_generation_port";
import { reconcileUsage, usageLedgerId } from "../src/usage";
import { buildCheapDemoRequest, validateCheapDemoControls, validateFetchableReferenceImage, validateVideoGenerationRequest } from "../src/video_generation_port";
import { buildAlibabaSubmitBody } from "../src/providers/alibaba";
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

test("provider-bound references require a signed https URL, never a bare bucket path", () => {
  // Offline regression for the live-submit defect: the provider cannot fetch
  // private GCS object paths, so any reference without a resolved signed https
  // URL fails closed before transport. Consent/tombstone gates are unchanged.
  const bare = {
    objectPath: "parties/pilot/guests/p-1/ingest/gsub-1/photo.jpg",
    sha256: "a".repeat(64),
    consentRevision: "v1:2026-10-30T00:00:00.000Z",
  };
  expectCode(() => validateFetchableReferenceImage({ ...bare }), "INVALID_ARGUMENT");
  expectCode(() => validateFetchableReferenceImage({ ...bare, url: "http://signed.invalid/photo.jpg" }), "INVALID_ARGUMENT");
  expectCode(() => validateFetchableReferenceImage({ ...bare, url: "gs://bucket/photo.jpg" }), "INVALID_ARGUMENT");
  expectCode(() => validateVideoGenerationRequest(buildCheapDemoRequest("job-1", "idem-1", "CAM-01", { ...bare })), "INVALID_ARGUMENT");
  const resolved = { ...bare, url: "https://signed.invalid/photo.jpg" };
  validateFetchableReferenceImage({ ...resolved });
  validateVideoGenerationRequest(buildCheapDemoRequest("job-1", "idem-1", "CAM-01", { ...resolved }));
});

test("offline fake keeps the live fetchability gate for cheap_demo references", async () => {
  // Layering regression for the cycle-11 merge interaction: the offline fake
  // resolves local bytes and never fetches, but it still enforces the same
  // signed-https fetchability gate as the live adapter, so an unfetchable
  // bare object-path reference can never be submitted on either boundary.
  // The worker resolves the consented photo through signReferenceReadUrl
  // (emulator tests wire the signing transport for that step); anything
  // unresolved fails here with the same signed-URL shape. Consent and
  // tombstone gates live one layer up and are unchanged.
  const bare = {
    objectPath: "parties/pilot/guests/p-1/ingest/gsub-1/photo.jpg",
    sha256: "a".repeat(64),
    consentRevision: "v1:2026-10-30T00:00:00.000Z",
  };
  const provider = new FakeVideoGenerationPort();
  await assert.rejects(
    provider.submit(buildCheapDemoRequest("job-cheap-bare", "idem-cheap-bare", "CAM-01", { ...bare })),
    /signed https URL/,
  );
  const submitted = await provider.submit(buildCheapDemoRequest("job-cheap-signed", "idem-cheap-signed", "CAM-01", {
    ...bare,
    url: "https://signed.invalid/photo.jpg",
  }));
  assert.ok(submitted.taskId.startsWith("CAM-01__"));
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

test("submit body uses the media-field form for references (no network)", () => {
  // Offline regression for the live r2v defect: the signed URL rides as
  // input.media; sha256 / reference_image never enter the submitted JSON.
  const reference = {
    objectPath: "parties/pilot/guests/p-1/ingest/gsub-1/photo.jpg",
    sha256: "c".repeat(64),
    consentRevision: "v1:2026-10-30T00:00:00.000Z",
    url: "https://signed.invalid/media-photo.jpg",
  };
  const body = buildAlibabaSubmitBody(buildCheapDemoRequest("job-media", "idem-media", "CAM-01", { ...reference }));
  assert.equal((body.input as Record<string, unknown>).media, "https://signed.invalid/media-photo.jpg");
  assert.ok(!("reference_image" in (body.input as Record<string, unknown>)));
  assert.ok(!JSON.stringify(body).includes("c".repeat(64)));
});

test("worker surfaces a provider FAILED reason in the error and on the job doc", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-fail-reason";
  const channelId = "main";
  const jobId = "job-fail-reason";
  const idempotencyKey = "idem-fail-reason";
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const failingProvider = {
      async submit(_request: VideoGenerationRequest) { return { taskId: "CAM-01__failreason000000000001" }; },
      async getStatus(_taskId: string): Promise<ProviderTaskStatus> {
        return { state: "FAILED", errorCode: "InvalidParameter", errorMessage: "Field required: input.media" };
      },
      async getResult(_taskId: string): Promise<ProviderResult> {
        throw new BackendError("PROVIDER_UNAVAILABLE", "unreachable");
      },
    };
    const services = createGenerationServices({
      db, bucket, provider: failingProvider, pollIntervalMs: 1, sleep: async () => undefined,
    });
    await services.requestGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo" });
    await assert.rejects(services.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey }),
      (error: unknown) => error instanceof BackendError
        && error.errorCode === "PROVIDER_UNAVAILABLE"
        && /Field required: input\.media/.test(error.message));
    const job = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()!;
    assert.equal(job.state, "failed");
    assert.ok(typeof job.providerErrorCode === "string" && job.providerErrorCode.includes("InvalidParameter"));
    assert.ok(job.providerErrorCode.includes("Field_required"));
    assert.ok(!JSON.stringify(job).includes("https://"));
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("worker keeps the generic mapping when a FAILED task carries no reason", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-fail-empty";
  const channelId = "main";
  const jobId = "job-fail-empty";
  const idempotencyKey = "idem-fail-empty";
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const emptyProvider = {
      async submit(_request: VideoGenerationRequest) { return { taskId: "CAM-01__failempty000000000001" }; },
      async getStatus(_taskId: string): Promise<ProviderTaskStatus> { return { state: "FAILED" }; },
      async getResult(_taskId: string): Promise<ProviderResult> {
        throw new BackendError("PROVIDER_UNAVAILABLE", "unreachable");
      },
    };
    const services = createGenerationServices({
      db, bucket, provider: emptyProvider, pollIntervalMs: 1, sleep: async () => undefined,
    });
    await services.requestGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo" });
    await assert.rejects(services.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey }),
      (error: unknown) => error instanceof BackendError
        && error.errorCode === "PROVIDER_UNAVAILABLE"
        && error.message === "Provider task failed.");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
