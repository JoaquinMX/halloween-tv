import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { Bucket } from "@google-cloud/storage";
import type { Firestore } from "firebase-admin/firestore";
import { BackendError } from "../src/contracts";
import { GUEST_CONSENT_PURPOSE, GUEST_CONSENT_TEXT_VERSION, REQUIRED_CAMERA_IDS } from "../src/config";
import { createRuntimeServices } from "../src/runtime";
import { FakeVideoGenerationPort } from "../src/providers/fake";
import { reconcileUsage, usageLedgerId } from "../src/usage";
import { ProviderResult, ProviderTaskStatus, VideoGenerationRequest } from "../src/video_generation_port";
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

class TrackingFakeProvider extends FakeVideoGenerationPort {
  submissions: VideoGenerationRequest[] = [];
  override async submit(request: VideoGenerationRequest) {
    this.submissions.push(request);
    return super.submit(request);
  }
}

function stubReferenceSigning(bucket: Bucket): void {
  // Stub GCS v4 signing for the emulator: the worker resolves the guest photo
  // to a short-lived signed https URL via bucket.getSignedUrl (same machinery
  // as delivery signReadUrl). The stub keeps save/download on the real file
  // object and only replaces signing with a deterministic https URL.
  // Idempotent: safe to call for a bucket that is already stubbed.
  const current = bucket.file as Bucket["file"] & { __referenceSigningStubbed?: boolean };
  if (current.__referenceSigningStubbed) return;
  const originalFile = bucket.file.bind(bucket);
  const stubbed = ((path: string, ...rest: unknown[]) => {
    const ref = (originalFile as (...args: unknown[]) => ReturnType<Bucket["file"]>)(path, ...rest);
    ref.getSignedUrl = (async () => [`https://signed.invalid/${encodeURIComponent(String(path))}`]) as unknown as typeof ref.getSignedUrl;
    return ref;
  }) as Bucket["file"] & { __referenceSigningStubbed?: boolean };
  stubbed.__referenceSigningStubbed = true;
  (bucket as unknown as { file: Bucket["file"] }).file = stubbed;
}

function servicesFor(db: Firestore, bucket: Bucket, provider: TrackingFakeProvider) {
  stubReferenceSigning(bucket);
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
  // Upload phase runs with generation disabled: eligible completion stays
  // fully operational without auto-enqueueing, so the explicit
  // requestGeneration path under test keeps a clean budget. Auto-enqueue is
  // covered by dedicated tests (guest_upload_e2e).
  const upload = createRuntimeServices({
    db,
    bucket,
    generationEnabled: false,
    pollIntervalMs: 1,
    sleep: async () => undefined,
    signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
    signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
  });
  const requested = await upload.requestGuestUpload({ partyId, deviceId, channelId, consent: CONSENT, contentType: "image/jpeg" });
  const photo = await readFile(resolve(__dirname, "fixtures/guest_photo.jpg"));
  await bucket.file(requested.objectPath).save(photo, { contentType: "image/jpeg" });
  const completed = await upload.completeGuestUpload({ partyId, deviceId, channelId, submissionId: requested.submissionId });
  assert.equal(completed.status, "eligible");
  return { requested, completed, photoHash: createHash("sha256").update(photo).digest("hex") };
}

test("consent-bound generation: one provider camera, three fixture slots, truthful usage", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "p-guest-gen";
  const channelId = "main";
  const provider = new TrackingFakeProvider();
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const services = servicesFor(db, bucket, provider);
    const { requested, completed, photoHash } = await eligibleGuestMedia(services, db, bucket, partyId, deviceId, channelId);

    const jobId = "job-guest-bound";
    const idempotencyKey = "idem-guest-bound";
    const request = await services.requestGeneration({
      partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo", guestMediaId: requested.submissionId,
    });
    assert.equal(request.state, "queued");
    const storedJob = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()!;
    assert.equal(storedJob.guestMedia.submissionId, requested.submissionId);
    assert.equal(storedJob.guestMedia.sourceHash, photoHash);
    assert.equal(storedJob.guestMedia.consentRevision, completed.consentRevision);

    const run = await services.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey });
    assert.equal(run.state, "ready");

    // Exactly ONE provider submission, carrying the validated image binding.
    assert.equal(provider.submissions.length, 1);
    const submitted = provider.submissions[0];
    assert.equal(submitted.cameraId, "CAM-01");
    assert.equal(submitted.modelId, "wan3.0-video");
    assert.equal(submitted.resolution, "480P");
    assert.equal(submitted.secondsOut, 2);
    assert.equal(submitted.audio, false);
    assert.equal(submitted.outputs, 1);
    // The worker resolved the private bucket path to a fetchable signed https
    // URL for the in-flight submit; the server-side binding is unchanged.
    assert.ok(typeof submitted.referenceImage?.url === "string" && submitted.referenceImage.url.startsWith("https://"));
    assert.deepEqual(submitted.referenceImage, {
      objectPath: requested.objectPath,
      sha256: photoHash,
      consentRevision: completed.consentRevision,
      url: submitted.referenceImage?.url,
    });
    // No signed URL is persisted on the stored job doc.
    const reloadedJob = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()!;
    assert.ok(!JSON.stringify(reloadedJob).includes("signed.invalid"));

    // Four playable published clips on the canonical four-camera manifest.
    const manifest = (await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get()).data()!;
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.cameraClips.map((c: { cameraId: string }) => c.cameraId), [...REQUIRED_CAMERA_IDS]);
    for (const clip of manifest.cameraClips as Array<{ cameraId: string; objectPath: string; sha256: string; sizeBytes: number; durationMs: number }>) {
      assert.equal(clip.durationMs, 2000);
      const [bytes] = await bucket.file(clip.objectPath).download();
      assert.ok(bytes.byteLength > 0, `${clip.cameraId} has no playable bytes`);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), clip.sha256);
      assert.equal(bytes.byteLength, clip.sizeBytes);
    }

    // Exactly ONE provider usage outcome. The fake credits zero is synthetic
    // zero from the offline provider, explicitly not a measured provider charge.
    const providerLedger = (await db.doc(`parties/${partyId}/costLogs/${usageLedgerId(jobId, "CAM-01")}`).get()).data()!;
    assert.equal(providerLedger.success, true);
    assert.ok(typeof providerLedger.provider_task_id === "string" && providerLedger.provider_task_id.startsWith("CAM-01__"));
    assert.equal(providerLedger.credits_charged, 0, "synthetic zero from the offline fake provider, not a measured charge");
    assert.equal(providerLedger.fixture ?? null, null);
    for (const cameraId of ["CAM-02", "CAM-03", "CAM-04"] as const) {
      const fixture = (await db.doc(`parties/${partyId}/costLogs/${usageLedgerId(jobId, cameraId)}`).get()).data()!;
      assert.equal(fixture.success, true);
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

test("withdrawal racing a running job discards the result and cleans staged bytes", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "p-guest-race";
  const channelId = "main";
  const racingProvider = new TrackingFakeProvider();
  const services = servicesFor(db, bucket, racingProvider);
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const { requested } = await eligibleGuestMedia(services, db, bucket, partyId, deviceId, channelId);
    const jobId = "job-guest-race";
    const idempotencyKey = "idem-guest-race";
    await services.requestGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo", guestMediaId: requested.submissionId });
    // Withdraw after the job is queued but before the worker runs: the claim
    // fails closed on the withdrawn job without any provider submission.
    await services.withdrawGuestMedia({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    const raced = await services.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey });
    assert.equal(raced.state, "failed");
    assert.equal(racingProvider.submissions.length, 0);
    const job = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()!;
    assert.equal(job.state, "failed");
    assert.equal(job.errorCode, "FORBIDDEN");
    assert.equal((await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get()).exists, false);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("mid-run withdrawal discards an already-staged provider result", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "p-guest-midrun";
  const channelId = "main";
  try {
    stubReferenceSigning(bucket);
    await seedParty(db, partyId, deviceId, channelId);
    let withdrawNow: (() => Promise<unknown>) | undefined;
    class MidRunProvider extends FakeVideoGenerationPort {
      submissions = 0;
      override async submit(request: VideoGenerationRequest) {
        this.submissions += 1;
        return super.submit(request);
      }
      override async getResult(taskId: string): Promise<ProviderResult> {
        // Consent is revoked after the provider result exists but before the
        // worker publishes: publication must fail closed and staged bytes
        // must be cleaned.
        await withdrawNow?.();
        return super.getResult(taskId);
      }
      override async getStatus(taskId: string): Promise<ProviderTaskStatus> {
        return super.getStatus(taskId);
      }
    }
    const midProvider = new MidRunProvider();
    const services = createRuntimeServices({
      db, bucket, generationEnabled: true, provider: midProvider, fixtureDirectory: FIXTURE_DIR,
      enqueueGeneration: async () => undefined,
      pollIntervalMs: 1, sleep: async () => undefined,
      signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
      signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
    });
    const { requested } = await eligibleGuestMedia(services, db, bucket, partyId, deviceId, channelId);
    const jobId = "job-guest-midrun";
    const idempotencyKey = "idem-guest-midrun";
    await services.requestGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo", guestMediaId: requested.submissionId });
    withdrawNow = () => services.withdrawGuestMedia({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    await assert.rejects(services.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey }),
      (e: unknown) => e instanceof BackendError && (e.errorCode === "FORBIDDEN" || e.errorCode === "MANIFEST_MISMATCH"));
    assert.equal(midProvider.submissions, 1);
    const job = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()!;
    assert.equal(job.state, "failed");
    assert.equal((await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get()).exists, false);
    const staged = (job.stagedOutputs ?? {}) as Record<string, { objectPath?: string }>;
    for (const cameraId of REQUIRED_CAMERA_IDS) {
      const path = staged[cameraId]?.objectPath;
      if (typeof path === "string") assert.equal((await bucket.file(path).exists())[0], false, `${cameraId} staged bytes cleaned`);
    }
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("text-only generation still uses four provider cameras", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const provider = new TrackingFakeProvider();
  try {
    await seedParty(db, partyId, "tv-text", "main");
    const services = servicesFor(db, bucket, provider);
    await services.requestGeneration({ partyId, deviceId: "tv-text", channelId: "main", jobId: "job-text", idempotencyKey: "idem-text", presetId: "cheap_demo" });
    await services.runGeneration({ partyId, deviceId: "tv-text", channelId: "main", jobId: "job-text", idempotencyKey: "idem-text" });
    assert.equal(provider.submissions.length, 4);
    assert.ok(provider.submissions.every((s) => s.referenceImage === undefined));
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("scoped provenance replaces blanket guest assumptions for legacy seeds", async () => {
  const { evaluateDeliveryProvenance, isExplicitlySupportedLegacyArtifact } = await import("../src/contracts");
  const job = { partyId: "p", channelId: "main", jobId: "job-legacy", seedProvenance: { seedId: "seed-1", kind: "operator" } };
  const seed = { seedId: "seed-1", partyId: "p", channelId: "main", status: "ready", operatorApproved: true, expiresAt: "2030-01-01T00:00:00.000Z" };
  assert.ok(isExplicitlySupportedLegacyArtifact(job, seed));
  assert.equal(evaluateDeliveryProvenance({ job, seed, nowMs: Date.now() }), "operator");
  // Changed-source guest binding is an explicit FORBIDDEN, not a silent pass.
  const guestJob = { partyId: "p", channelId: "main", jobId: "job-g", guestMedia: { submissionId: "gsub-1", sourceHash: "a".repeat(64), consentRevision: "v1:t" } };
  const changed = { submissionId: "gsub-1", partyId: "p", channelId: "main", status: "eligible", consent: { accepted: true, textVersion: "v1", purpose: "guest_cameo" }, sourceHash: "c".repeat(64), consentRevision: "v1:t", expiresAt: "2030-01-01T00:00:00.000Z" };
  assert.throws(() => evaluateDeliveryProvenance({ job: guestJob, guest: changed, nowMs: Date.now() }),
    (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
});
