import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { Bucket } from "@google-cloud/storage";
import type { Firestore } from "firebase-admin/firestore";
import { BackendError } from "../src/contracts";
import { CAMEO_DEMO_PRESET, CAMEO_DEMO_PROMPT, GUEST_CONSENT_PURPOSE, GUEST_CONSENT_TEXT_VERSION } from "../src/config";
import { createRuntimeServices } from "../src/runtime";
import { FakeVideoGenerationPort } from "../src/providers/fake";
import { reconcileUsage, usageLedgerId } from "../src/usage";
import { VideoGenerationRequest } from "../src/video_generation_port";
import { parseRequestGeneration } from "../src/contracts";
import {
  buildCameoDemoRequest,
  buildCheapDemoRequest,
  validateCameoDemoControls,
  validateCheapDemoControls,
  validatePresetControls,
} from "../src/video_generation_port";
import {
  HAS_FIRESTORE_EMULATOR,
  clearParty,
  createEmulatorContext,
  disposeEmulatorContext,
  randomPartyId,
  seedParty,
} from "./support/emulators";

const FIXTURE_DIR = resolve(__dirname, "../../../apps/tv_app/assets");
const CONSENT = { accepted: true, textVersion: GUEST_CONSENT_TEXT_VERSION, purpose: GUEST_CONSENT_PURPOSE };

function expectCode(work: () => unknown, code: string): void {
  assert.throws(work, (error: unknown) => error instanceof BackendError && error.errorCode === code);
}

test("preset lock rejects altered cheap_demo controls and altered cameo_demo controls", () => {
  // cheap_demo lock is unchanged: any deviation is rejected.
  expectCode(() => validateCheapDemoControls({ presetId: "cheap_demo", modelId: "another-model" }), "INVALID_ARGUMENT");
  expectCode(() => validateCheapDemoControls({ presetId: "cheap_demo", resolution: "720P" }), "INVALID_ARGUMENT");
  expectCode(() => validateCheapDemoControls({ presetId: "cheap_demo", secondsOut: 5 }), "INVALID_ARGUMENT");
  expectCode(() => validateCheapDemoControls({ presetId: "cheap_demo", outputs: 2 }), "INVALID_ARGUMENT");
  expectCode(() => validateCheapDemoControls({ presetId: "cheap_demo", audio: true }), "INVALID_ARGUMENT");
  // Dispatcher keeps the cheap_demo lock for cheap requests...
  expectCode(() => validatePresetControls({ presetId: "cheap_demo", secondsOut: 5 }), "INVALID_ARGUMENT");
  expectCode(() => validatePresetControls({ modelId: "wan3.0-video", secondsOut: 5 }), "INVALID_ARGUMENT");
  // ...and enforces the separate cameo_demo lock for cameo requests.
  expectCode(() => validateCameoDemoControls({ presetId: "cameo_demo", modelId: "wan3.0-video" }), "INVALID_ARGUMENT");
  expectCode(() => validateCameoDemoControls({ presetId: "cameo_demo", secondsOut: 2 }), "INVALID_ARGUMENT");
  expectCode(() => validateCameoDemoControls({ presetId: "cameo_demo", resolution: "720P" }), "INVALID_ARGUMENT");
  expectCode(() => validateCameoDemoControls({ presetId: "cameo_demo", outputs: 2 }), "INVALID_ARGUMENT");
  expectCode(() => validateCameoDemoControls({ presetId: "cameo_demo", audio: true }), "INVALID_ARGUMENT");
  expectCode(() => validatePresetControls({ presetId: "cameo_demo", modelId: "wan3.0-video" }), "INVALID_ARGUMENT");
});

test("cameo_demo requires a consent-bound guestMediaId and a fixed server prompt", () => {
  // Text-only requests for this preset are rejected: it exists solely for the consented-reference batch.
  expectCode(() => parseRequestGeneration({
    partyId: "party", deviceId: "tv", channelId: "main", jobId: "job-1", idempotencyKey: "job-1", presetId: "cameo_demo",
  }), "INVALID_ARGUMENT");
  expectCode(() => parseRequestGeneration({
    partyId: "party", deviceId: "tv", channelId: "main", jobId: "job-1", idempotencyKey: "job-1",
    presetId: "cameo_demo", guestMediaId: "",
  }), "INVALID_ARGUMENT");
  const parsed = parseRequestGeneration({
    partyId: "party", deviceId: "tv", channelId: "main", jobId: "job-1", idempotencyKey: "job-1",
    presetId: "cameo_demo", guestMediaId: "gsub-1",
  });
  assert.equal(parsed.presetId, "cameo_demo");
  assert.equal(parsed.guestMediaId, "gsub-1");
  // Control overrides are rejected against the cameo lock, not cheap_demo's.
  expectCode(() => parseRequestGeneration({
    partyId: "party", deviceId: "tv", channelId: "main", jobId: "job-1", idempotencyKey: "job-1",
    presetId: "cameo_demo", guestMediaId: "gsub-1", secondsOut: 2,
  }), "INVALID_ARGUMENT");
  expectCode(() => parseRequestGeneration({
    partyId: "party", deviceId: "tv", channelId: "main", jobId: "job-1", idempotencyKey: "job-1",
    presetId: "cameo_demo", guestMediaId: "gsub-1", modelId: "wan3.0-video",
  }), "INVALID_ARGUMENT");
  // The builder pins the approved prompt and requires the reference image.
  const reference = {
    objectPath: "parties/pilot/guests/p-1/ingest/gsub-1/photo.jpg",
    sha256: "a".repeat(64),
    consentRevision: "v1:2026-10-30T00:00:00.000Z",
  };
  expectCode(() => buildCameoDemoRequest("job-1", "idem-1", "CAM-01", undefined), "INVALID_ARGUMENT");
  const request = buildCameoDemoRequest("job-1", "idem-1", "CAM-01", reference);
  assert.equal(request.presetId, "cameo_demo");
  assert.equal(request.modelId, CAMEO_DEMO_PRESET.modelId);
  assert.equal(request.secondsOut, 5);
  assert.equal(request.prompt, CAMEO_DEMO_PROMPT);
  assert.deepEqual(request.referenceImage, reference);
  // cheap_demo builder is untouched.
  const cheap = buildCheapDemoRequest("job-1", "idem-1", "CAM-01");
  assert.equal(cheap.presetId, "cheap_demo");
  assert.equal(cheap.modelId, "wan3.0-video");
  assert.equal(cheap.secondsOut, 2);
  assert.equal(cheap.referenceImage, undefined);
});

test("fake provider reports the 5s cameo shape offline and keeps the 2s cheap shape", async () => {
  const provider = new FakeVideoGenerationPort(FIXTURE_DIR);
  const reference = {
    objectPath: "parties/pilot/guests/p-1/ingest/gsub-1/photo.jpg",
    sha256: "b".repeat(64),
    consentRevision: "v1:2026-10-30T00:00:00.000Z",
  };
  const cameo = await provider.submit(buildCameoDemoRequest("job-cameo-offline", "idem-cameo-offline", "CAM-01", reference));
  assert.equal((await provider.getResult(cameo.taskId)).secondsOut, 5);
  const cheap = await provider.submit(buildCheapDemoRequest("job-cheap-offline", "idem-cheap-offline", "CAM-01"));
  assert.equal((await provider.getResult(cheap.taskId)).secondsOut, 2);
});

class TrackingFakeProvider extends FakeVideoGenerationPort {
  submissions: VideoGenerationRequest[] = [];
  override async submit(request: VideoGenerationRequest) {
    this.submissions.push(request);
    return super.submit(request);
  }
}

function servicesFor(db: Firestore, bucket: Bucket, provider: TrackingFakeProvider) {
  return createRuntimeServices({
    db,
    bucket,
    generationEnabled: true,
    provider,
    fixtureDirectory: FIXTURE_DIR,
    enqueueGeneration: async () => undefined,
    pollIntervalMs: 1,
    sleep: async () => undefined,
    signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
    signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
  });
}

async function eligibleGuestMedia(services: ReturnType<typeof createRuntimeServices>, db: Firestore, bucket: Bucket, partyId: string, deviceId: string, channelId: string) {
  const requested = await services.requestGuestUpload({ partyId, deviceId, channelId, consent: CONSENT, contentType: "image/jpeg" });
  const photo = await readFile(resolve(__dirname, "fixtures/guest_photo.jpg"));
  await bucket.file(requested.objectPath).save(photo, { contentType: "image/jpeg" });
  const completed = await services.completeGuestUpload({ partyId, deviceId, channelId, submissionId: requested.submissionId });
  assert.equal(completed.status, "eligible");
  return { requested, completed, photoHash: createHash("sha256").update(photo).digest("hex") };
}

test("guest-bound cameo_demo runs one 5s provider camera plus three fixture slots", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "p-cameo-gen";
  const channelId = "main";
  const provider = new TrackingFakeProvider();
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const services = servicesFor(db, bucket, provider);
    const { requested, completed, photoHash } = await eligibleGuestMedia(services, db, bucket, partyId, deviceId, channelId);

    // Caller-supplied prompts are rejected for the cameo preset too.
    await assert.rejects(services.requestGeneration({
      partyId, deviceId, channelId, jobId: "job-cameo-prompt", idempotencyKey: "idem-cameo-prompt",
      presetId: "cameo_demo", guestMediaId: requested.submissionId, prompt: "caller prompt",
    }), (error: unknown) => error instanceof BackendError && error.errorCode === "INVALID_ARGUMENT");
    // Text-only cameo requests are rejected.
    await assert.rejects(services.requestGeneration({
      partyId, deviceId, channelId, jobId: "job-cameo-text", idempotencyKey: "idem-cameo-text", presetId: "cameo_demo",
    }), (error: unknown) => error instanceof BackendError && error.errorCode === "INVALID_ARGUMENT");

    const jobId = "job-cameo-bound";
    const idempotencyKey = "idem-cameo-bound";
    const request = await services.requestGeneration({
      partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cameo_demo", guestMediaId: requested.submissionId,
    });
    assert.equal(request.state, "queued");
    const storedJob = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()!;
    assert.equal(storedJob.presetId, "cameo_demo");
    assert.equal(storedJob.modelId, "happyhorse-1.1-r2v");
    assert.deepEqual(storedJob.costEstimate, { modelId: "happyhorse-1.1-r2v", presetId: "cameo_demo", secondsOut: 5 });
    assert.equal(storedJob.guestMedia.submissionId, requested.submissionId);
    assert.equal(storedJob.guestMedia.sourceHash, photoHash);

    const run = await services.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey });
    assert.equal(run.state, "ready");

    // Exactly ONE provider submission, carrying the fixed prompt and the validated image binding.
    assert.equal(provider.submissions.length, 1);
    const submitted = provider.submissions[0];
    assert.equal(submitted.cameraId, "CAM-01");
    assert.equal(submitted.presetId, "cameo_demo");
    assert.equal(submitted.modelId, "happyhorse-1.1-r2v");
    assert.equal(submitted.secondsOut, 5);
    assert.equal(submitted.prompt, CAMEO_DEMO_PROMPT);
    assert.deepEqual(submitted.referenceImage, {
      objectPath: requested.objectPath,
      sha256: photoHash,
      consentRevision: completed.consentRevision,
    });

    // Four playable published clips on the canonical four-camera manifest, all at the 5s cameo duration.
    const manifest = (await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get()).data()!;
    assert.equal(manifest.version, 1);
    assert.equal(manifest.jobId, jobId);
    for (const clip of manifest.cameraClips as Array<{ cameraId: string; objectPath: string; sha256: string; sizeBytes: number; durationMs: number }>) {
      assert.equal(clip.durationMs, 5000);
      const [bytes] = await bucket.file(clip.objectPath).download();
      assert.ok(bytes.byteLength > 0, `${clip.cameraId} has no playable bytes`);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), clip.sha256);
      assert.equal(bytes.byteLength, clip.sizeBytes);
    }

    // Truthful usage: one provider outcome at 5s, three fixture slots with no fabricated task or charge.
    const providerLedger = (await db.doc(`parties/${partyId}/costLogs/${usageLedgerId(jobId, "CAM-01")}`).get()).data()!;
    assert.equal(providerLedger.success, true);
    assert.equal(providerLedger.preset_id, "cameo_demo");
    assert.equal(providerLedger.model_id, "happyhorse-1.1-r2v");
    assert.equal(providerLedger.seconds_out, 5);
    assert.ok(typeof providerLedger.provider_task_id === "string" && providerLedger.provider_task_id.startsWith("CAM-01__"));
    assert.equal(providerLedger.credits_charged, 0, "synthetic zero from the offline fake provider, not a measured charge");
    for (const cameraId of ["CAM-02", "CAM-03", "CAM-04"] as const) {
      const fixture = (await db.doc(`parties/${partyId}/costLogs/${usageLedgerId(jobId, cameraId)}`).get()).data()!;
      assert.equal(fixture.success, true);
      assert.equal(fixture.preset_id, "cameo_demo");
      assert.equal(fixture.provider_task_id, null, `no fabricated provider task ID for fixture slot ${cameraId}`);
      assert.equal(fixture.credits_charged, null, `no fabricated charge for fixture slot ${cameraId}`);
      assert.equal(fixture.fixture, true);
    }
    assert.deepEqual(await reconcileUsage(db), []);
    const budget = (await db.doc(`parties/${partyId}/generationBudget/active`).get()).data();
    assert.equal(budget?.state, "idle");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("tombstone and withdrawal fail closed under cameo_demo with no provider submission", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "p-cameo-tomb";
  const channelId = "main";
  const provider = new TrackingFakeProvider();
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const services = servicesFor(db, bucket, provider);
    const { requested } = await eligibleGuestMedia(services, db, bucket, partyId, deviceId, channelId);
    const jobId = "job-cameo-withdrawn";
    const idempotencyKey = "idem-cameo-withdrawn";
    await services.requestGeneration({
      partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cameo_demo", guestMediaId: requested.submissionId,
    });
    // Withdrawal lands after queueing: the tombstoned binding fails the worker closed.
    await services.withdrawGuestMedia({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    const tombstoned = (await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).get()).data()!;
    assert.equal(tombstoned.status, "withdrawn");
    assert.equal(tombstoned.tombstone, true);
    const raced = await services.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey });
    assert.equal(raced.state, "failed");
    assert.equal(provider.submissions.length, 0);
    const job = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()!;
    assert.equal(job.state, "failed");
    assert.equal(job.errorCode, "FORBIDDEN");
    assert.equal((await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get()).exists, false);
    // A fresh request against the tombstoned media fails closed at the request gate too.
    await assert.rejects(services.requestGeneration({
      partyId, deviceId, channelId, jobId: "job-cameo-tombstoned", idempotencyKey: "idem-cameo-tombstoned",
      presetId: "cameo_demo", guestMediaId: requested.submissionId,
    }), (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
