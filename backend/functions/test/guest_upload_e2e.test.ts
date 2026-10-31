import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { Bucket } from "@google-cloud/storage";
import type { Firestore } from "firebase-admin/firestore";
import { BackendError } from "../src/contracts";
import { GUEST_CONSENT_PURPOSE, GUEST_CONSENT_TEXT_VERSION } from "../src/config";
import { createRuntimeServices } from "../src/runtime";
import { FakeVideoGenerationPort } from "../src/providers/fake";
import { FakeImageGenerationPort } from "../src/providers/fake_image";
import {
  HAS_FIRESTORE_EMULATOR,
  clearParty,
  createEmulatorContext,
  disposeEmulatorContext,
  randomPartyId,
  seedParty,
} from "./support/emulators";

const FIXTURE_DIR = resolve(__dirname, "../../../apps/tv_app/assets");

/**
 * Endpoint-level guest lifecycle through the production runtime composition
 * with real Firestore documents and real Storage bytes. The PUT itself is a
 * direct object write: the Storage emulator cannot mint real v4 signed PUT
 * URLs, so the injected signer only proves the capability is per-submission
 * and never persisted. Cloud IAM signing is explicitly not equivalent.
 */
function productionServices(db: Firestore, bucket: Bucket) {
  return createRuntimeServices({
    db,
    bucket,
    generationEnabled: true,
    provider: new FakeVideoGenerationPort(),
    pollIntervalMs: 1,
    sleep: async () => undefined,
    signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
    signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
  });
}

test("guest photo lifecycle: consent, upload, completion, withdrawal tombstone", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "p-e2e-guest";
  const channelId = "main";
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const services = productionServices(db, bucket);
    const consent = { accepted: true, textVersion: GUEST_CONSENT_TEXT_VERSION, purpose: GUEST_CONSENT_PURPOSE };

    const requested = await services.requestGuestUpload({ partyId, deviceId, channelId, consent, contentType: "image/jpeg" });
    assert.match(requested.submissionId, /^gsub-[a-f0-9]{32}$/);
    assert.equal(requested.objectPath, `parties/${partyId}/guests/${deviceId}/ingest/${requested.submissionId}/photo.jpg`);
    assert.ok(requested.uploadUrl.length > 0);
    assert.ok(requested.expiresAt);
    assert.ok(requested.consentRevision.startsWith("v1:"));

    const photo = await readFile(resolve(__dirname, "fixtures/guest_photo.jpg"));
    assert.ok(photo.byteLength > 0);
    await bucket.file(requested.objectPath).save(photo, { contentType: "image/jpeg" });
    const expectedHash = createHash("sha256").update(photo).digest("hex");

    const completed = await services.completeGuestUpload({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    assert.equal(completed.status, "eligible");
    assert.equal(completed.sha256, expectedHash);
    assert.equal(completed.sizeBytes, photo.byteLength);
    assert.equal(completed.consentRevision, requested.consentRevision);

    const status = await services.getGuestMediaStatus({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    assert.equal(status.status, "eligible");
    assert.equal(status.sha256, expectedHash);

    const withdrawn = await services.withdrawGuestMedia({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    assert.equal(withdrawn.status, "withdrawn");
    assert.equal(withdrawn.verifiedAbsent, true);
    assert.equal((await bucket.file(requested.objectPath).exists())[0], false);

    const tombstone = (await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).get()).data()!;
    assert.equal(tombstone.status, "withdrawn");
    assert.equal(tombstone.tombstone, true);
    assert.equal(tombstone.partyId, partyId);
    assert.equal(tombstone.deviceId, deviceId);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("non-image bytes never become eligible", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "p-e2e-guest", "main");
    const services = productionServices(db, bucket);
    const requested = await services.requestGuestUpload({
      partyId, deviceId: "p-e2e-guest", channelId: "main",
      consent: { accepted: true, textVersion: "v1", purpose: "guest_cameo" }, contentType: "image/jpeg",
    });
    await bucket.file(requested.objectPath).save(Buffer.from("not an image at all"), { contentType: "image/jpeg" });
    await assert.rejects(services.completeGuestUpload({ partyId, deviceId: "p-e2e-guest", channelId: "main", submissionId: requested.submissionId }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT");
    assert.equal((await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).get()).data()?.status, "pending_upload");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("withdrawn guest consent denies wall delivery without fabricating consent", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { createDeliveryServices } = await import("../src/delivery");
  const { SCHEMA_VERSION } = await import("../src/config");
  const { FieldValue } = await import("firebase-admin/firestore");
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "p-e2e-guest", "main");
    const services = productionServices(db, bucket);
    const requested = await services.requestGuestUpload({
      partyId, deviceId: "p-e2e-guest", channelId: "main",
      consent: { accepted: true, textVersion: GUEST_CONSENT_TEXT_VERSION, purpose: GUEST_CONSENT_PURPOSE }, contentType: "image/jpeg",
    });
    await services.withdrawGuestMedia({ partyId, deviceId: "p-e2e-guest", channelId: "main", submissionId: requested.submissionId });
    const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await db.doc(`parties/${partyId}/jobs/job-withdrawn`).set({
      jobId: "job-withdrawn", partyId, deviceId: "p-e2e-guest", channelId: "main",
      manifestVersion: 1, idempotencyKey: "job-withdrawn", state: "failed",
      guestMedia: { submissionId: requested.submissionId, sourceHash: "a".repeat(64), consentRevision: requested.consentRevision, deviceId: "p-e2e-guest", channelId: "main" },
    });
    await db.doc(`parties/${partyId}/manifests/current_main`).set({
      partyId, channelId: "main", version: 1, schemaVersion: SCHEMA_VERSION, jobId: "job-withdrawn", expiresAt: expiry,
      createdAt: FieldValue.serverTimestamp(), cameraClips: ["CAM-01", "CAM-02", "CAM-03", "CAM-04"].map((cameraId) => ({
        cameraId, objectPath: `parties/${partyId}/channels/main/delivery/1/${cameraId}.mp4`,
        sha256: createHash("sha256").update(cameraId).digest("hex"), sizeBytes: 1, durationMs: 2000, expiresAt: expiry,
      })),
    });
    const delivery = createDeliveryServices({ db, bucket, signReadUrl: async () => "https://unused.invalid" });
    await assert.rejects(delivery.getDeliveryUrls({ partyId, deviceId: "p-e2e-guest", channelId: "main" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

/**
 * Upload-phase services with generation disabled: eligible completion stays
 * fully operational and never auto-enqueues.
 */
function uploadOnlyServices(db: Firestore, bucket: Bucket) {
  return createRuntimeServices({
    db,
    bucket,
    generationEnabled: false,
    pollIntervalMs: 1,
    sleep: async () => undefined,
    signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
    signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
  });
}

test("eligible-upload completion and ingest-finalization replay idempotently enqueue one backend-selected cartoon job", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "p-auto-guest";
  const channelId = "main";
  const enqueues: Array<Record<string, string>> = [];
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const services = createRuntimeServices({
      db,
      bucket,
      generationEnabled: true,
      provider: new FakeVideoGenerationPort(FIXTURE_DIR),
      fixtureDirectory: FIXTURE_DIR,
      enqueueGeneration: async (task) => { enqueues.push({ ...task }); },
      pollIntervalMs: 1,
      sleep: async () => undefined,
      signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
      signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
    });
    const requested = await services.requestGuestUpload({
      partyId, deviceId, channelId,
      consent: { accepted: true, textVersion: GUEST_CONSENT_TEXT_VERSION, purpose: GUEST_CONSENT_PURPOSE },
      contentType: "image/jpeg",
    });
    // No client prompt/scene/situation UI exists anywhere on this path: the
    // guest supplies consent + bytes only.
    const photo = await readFile(resolve(__dirname, "fixtures/guest_photo.jpg"));
    await bucket.file(requested.objectPath).save(photo, { contentType: "image/jpeg" });
    const completed = await services.completeGuestUpload({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    assert.equal(completed.status, "eligible");
    // Completion enqueued exactly one backend-selected cartoon job.
    assert.equal(enqueues.length, 1);
    assert.equal(enqueues[0].jobId, `cartoon-${requested.submissionId}`);
    const jobId = `cartoon-${requested.submissionId}`;
    const first = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()!;
    assert.equal(first.state, "queued");
    const firstPlan = first.cartoonPlan as Record<string, unknown>;
    assert.ok(typeof firstPlan.scenarioId === "string" && typeof firstPlan.situationId === "string");
    assert.equal(firstPlan.portraitSubmissionId, requested.submissionId);
    assert.equal(firstPlan.version, 1);
    assert.ok(typeof firstPlan.seed === "number" && typeof firstPlan.stillPlanId === "string" && typeof firstPlan.videoPlanId === "string");
    // The selected pair is a real compatible catalog pair.
    const { loadValidatedCatalogs, resolveFunctionsRoot, selectScenarioSituation } = await import("../src/scenario_catalog");
    const autoCatalogs = loadValidatedCatalogs(resolveFunctionsRoot(resolve(__dirname, "../src")));
    assert.doesNotThrow(() => selectScenarioSituation(
      autoCatalogs.catalog, autoCatalogs.situations,
      String(firstPlan.scenarioId), String(firstPlan.situationId),
    ));
    // Direct minimal request (guestMediaId-only) reuses the persisted plan:
    // never rerolls, never rebills.
    const repeat = await services.requestCartoonFromPortrait({ partyId, deviceId, channelId, guestMediaId: requested.submissionId });
    assert.equal(repeat.created, false);
    assert.equal(repeat.jobId, jobId);
    assert.equal(enqueues.length, 1, "re-request must not enqueue again");
    // Ingest-finalization trigger racing completion: idempotent, same plan.
    const finalized = await services.handleGuestIngestFinalized(requested.objectPath);
    assert.equal(finalized.handled, true);
    assert.equal(enqueues.length, 1, "finalization race must not enqueue again");
    const replayed = await services.handleGuestIngestFinalized(requested.objectPath);
    assert.equal(replayed.handled, true);
    assert.equal(enqueues.length, 1, "finalization replay must not enqueue again");
    // Re-completion replays safely through the same idempotent path.
    await services.completeGuestUpload({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    assert.equal(enqueues.length, 1, "completion replay must not enqueue again");
    const last = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()!;
    assert.deepEqual(last.cartoonPlan, firstPlan, "the persisted plan is immutable across retries and replays");
    assert.equal((await db.collection(`parties/${partyId}/jobs`).get()).size, 1, "exactly one job, one plan, one enqueue");
    // The client must not supply a plan, prompt, scene, or situation.
    await assert.rejects(services.requestCartoonFromPortrait({
      partyId, deviceId, channelId, guestMediaId: requested.submissionId, cartoonPlan: firstPlan,
    }), (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT");
    await assert.rejects(services.requestCartoonFromPortrait({
      partyId, deviceId, channelId, guestMediaId: requested.submissionId, prompt: "a custom prompt",
    }), (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT");
    await assert.rejects(services.requestGeneration({
      partyId, deviceId, channelId, jobId: "job-caller-plan", idempotencyKey: "idem-caller-plan",
      presetId: "cheap_demo", guestMediaId: requested.submissionId, cartoonPlan: firstPlan,
    }), (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("generation-disabled keeps upload fully operational with no auto job", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "p-off-guest", "main");
    const services = uploadOnlyServices(db, bucket);
    const requested = await services.requestGuestUpload({
      partyId, deviceId: "p-off-guest", channelId: "main",
      consent: { accepted: true, textVersion: GUEST_CONSENT_TEXT_VERSION, purpose: GUEST_CONSENT_PURPOSE },
      contentType: "image/jpeg",
    });
    const photo = await readFile(resolve(__dirname, "fixtures/guest_photo.jpg"));
    await bucket.file(requested.objectPath).save(photo, { contentType: "image/jpeg" });
    const completed = await services.completeGuestUpload({ partyId, deviceId: "p-off-guest", channelId: "main", submissionId: requested.submissionId });
    assert.equal(completed.status, "eligible");
    assert.equal((await db.collection(`parties/${partyId}/jobs`).get()).size, 0, "no job is enqueued while generation is disabled");
    await assert.rejects(services.requestCartoonFromPortrait({ partyId, deviceId: "p-off-guest", channelId: "main", guestMediaId: requested.submissionId }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "PROVIDER_UNAVAILABLE");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("minimal guest portrait request takes both cartoon stages end-to-end", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "p-cartoon-e2e";
  const channelId = "main";
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const upload = uploadOnlyServices(db, bucket);
    const gen = createRuntimeServices({
      db,
      bucket,
      generationEnabled: true,
      provider: new FakeVideoGenerationPort(FIXTURE_DIR),
      imageProvider: new FakeImageGenerationPort(),
      fixtureDirectory: FIXTURE_DIR,
      enqueueGeneration: async () => undefined,
      pollIntervalMs: 1,
      sleep: async () => undefined,
      signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
      signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
    });
    const requested = await upload.requestGuestUpload({
      partyId, deviceId, channelId,
      consent: { accepted: true, textVersion: GUEST_CONSENT_TEXT_VERSION, purpose: GUEST_CONSENT_PURPOSE },
      contentType: "image/jpeg",
    });
    const photo = await readFile(resolve(__dirname, "fixtures/guest_photo.jpg"));
    await bucket.file(requested.objectPath).save(photo, { contentType: "image/jpeg" });
    await upload.completeGuestUpload({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    // Minimal guest request: identity + guestMediaId only, rehearsal-marked
    // so the offline fixture still publishes as a rehearsal artifact.
    const created = await gen.requestCartoonFromPortrait({ partyId, deviceId, channelId, guestMediaId: requested.submissionId, rehearsalOnly: true });
    assert.equal(created.created, true);
    const jobId = created.jobId;
    const persisted = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()!;
    assert.equal(persisted.cartoonPlan.portraitSubmissionId, requested.submissionId);
    const run = await gen.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey: jobId });
    assert.equal(run.state, "ready");
    const chain = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()?.cartoonChain as Record<string, unknown>;
    assert.equal(chain.stillStatus, "completed");
    assert.equal(chain.stillFixture, true, "offline fake stills are marked fixture:true");
    assert.equal(chain.videoStillSha256, chain.stillSha256, "video animates the exact generated still");
    const delivery = await gen.getDeliveryUrls({ partyId, deviceId, channelId });
    assert.equal(delivery.clips.length, 4);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("host-photo portrait takes both cartoon stages end-to-end", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const host = "p-host-photo";
  const channelId = "main";
  try {
    await seedParty(db, partyId, host, channelId);
    await db.doc(`parties/${partyId}/devices/${host}`).update({ role: "host" });
    const upload = uploadOnlyServices(db, bucket);
    const gen = createRuntimeServices({
      db,
      bucket,
      generationEnabled: true,
      provider: new FakeVideoGenerationPort(FIXTURE_DIR),
      imageProvider: new FakeImageGenerationPort(),
      fixtureDirectory: FIXTURE_DIR,
      enqueueGeneration: async () => undefined,
      pollIntervalMs: 1,
      sleep: async () => undefined,
      signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
      signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
    });
    const requested = await upload.requestGuestUpload({
      partyId, deviceId: host, channelId,
      consent: { accepted: true, textVersion: "host_source_v1", purpose: "host_source" },
      contentType: "image/jpeg",
    });
    const photo = await readFile(resolve(__dirname, "fixtures/guest_photo.jpg"));
    await bucket.file(requested.objectPath).save(photo, { contentType: "image/jpeg" });
    await upload.completeGuestUpload({ partyId, deviceId: host, channelId, submissionId: requested.submissionId });
    const created = await gen.requestCartoonFromPortrait({ partyId, deviceId: host, channelId, guestMediaId: requested.submissionId, rehearsalOnly: true });
    assert.equal(created.created, true);
    const jobId = created.jobId;
    const run = await gen.runGeneration({ partyId, deviceId: host, channelId, jobId, idempotencyKey: jobId });
    assert.equal(run.state, "ready");
    const chain = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()?.cartoonChain as Record<string, unknown>;
    assert.equal(chain.stillStatus, "completed");
    assert.equal(chain.portraitSubmissionId, requested.submissionId);
    const delivery = await gen.getDeliveryUrls({ partyId, deviceId: host, channelId });
    assert.equal(delivery.clips.length, 4);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("offline fake stills never publish for non-rehearsal jobs", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "p-fake-still";
  const channelId = "main";
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const upload = uploadOnlyServices(db, bucket);
    const gen = createRuntimeServices({
      db,
      bucket,
      generationEnabled: true,
      provider: new FakeVideoGenerationPort(FIXTURE_DIR),
      imageProvider: new FakeImageGenerationPort(),
      fixtureDirectory: FIXTURE_DIR,
      enqueueGeneration: async () => undefined,
      pollIntervalMs: 1,
      sleep: async () => undefined,
      signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
      signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
    });
    const requested = await upload.requestGuestUpload({
      partyId, deviceId, channelId,
      consent: { accepted: true, textVersion: GUEST_CONSENT_TEXT_VERSION, purpose: GUEST_CONSENT_PURPOSE },
      contentType: "image/jpeg",
    });
    const photo = await readFile(resolve(__dirname, "fixtures/guest_photo.jpg"));
    await bucket.file(requested.objectPath).save(photo, { contentType: "image/jpeg" });
    await upload.completeGuestUpload({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    // No rehearsal marker: the offline fake still is recorded fixture:true
    // and publication refuses it for non-rehearsal jobs.
    const created = await gen.requestCartoonFromPortrait({ partyId, deviceId, channelId, guestMediaId: requested.submissionId });
    assert.equal(created.created, true);
    await assert.rejects(gen.runGeneration({ partyId, deviceId, channelId, jobId: created.jobId, idempotencyKey: created.jobId }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "MANIFEST_MISMATCH");
    const chain = (await db.doc(`parties/${partyId}/jobs/${created.jobId}`).get()).data()?.cartoonChain as Record<string, unknown>;
    assert.equal(chain.stillFixture, true);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("fix-5a busy party: pending intent persists, dispatches once with identical plan, withdrawn never dispatches, admission failure visible", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const channelId = "main";
  const enqueues: Array<Record<string, string>> = [];
  class CountingVideo extends FakeVideoGenerationPort {
    videoSubmits = 0;
    override async submit(request: import("../src/video_generation_port").VideoGenerationRequest) {
      this.videoSubmits += 1;
      return super.submit(request);
    }
  }
  const provider = new CountingVideo(FIXTURE_DIR);
  const imagePort = new FakeImageGenerationPort();
  const guest = (deviceId: string) => ({ partyId, deviceId, channelId });
  const photoPath = resolve(__dirname, "fixtures/guest_photo.jpg");
  try {
    await seedParty(db, partyId, "p-busy-1", channelId);
    await seedParty(db, partyId, "p-busy-2", channelId);
    // Upload phase for guest 1 runs with generation disabled so the explicit
    // rehearsal-marked occupier below keeps a clean budget. The occupier is
    // created through the real explicit path (not a hand-written job doc).
    const uploadOnly = createRuntimeServices({
      db, bucket, generationEnabled: false, pollIntervalMs: 1, sleep: async () => undefined,
      signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
      signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
    });
    const services = createRuntimeServices({
      db, bucket, generationEnabled: true, provider, imageProvider: imagePort,
      fixtureDirectory: FIXTURE_DIR,
      enqueueGeneration: async (task) => { enqueues.push({ ...task }); },
      pollIntervalMs: 1, sleep: async () => undefined,
      signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
      signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
    });
    const photo = await readFile(photoPath);

    // Guest 1 occupies capacity: eligible portrait + explicit rehearsal-marked
    // cartoon job, created and enqueued but NOT run yet.
    const req1 = await uploadOnly.requestGuestUpload({
      ...guest("p-busy-1"),
      consent: { accepted: true, textVersion: GUEST_CONSENT_TEXT_VERSION, purpose: GUEST_CONSENT_PURPOSE },
      contentType: "image/jpeg",
    });
    await bucket.file(req1.objectPath).save(photo, { contentType: "image/jpeg" });
    await uploadOnly.completeGuestUpload({ ...guest("p-busy-1"), submissionId: req1.submissionId });
    const created1 = await services.requestCartoonFromPortrait({
      ...guest("p-busy-1"), guestMediaId: req1.submissionId, rehearsalOnly: true,
    });
    assert.equal(created1.created, true);
    const job1 = created1.jobId;
    assert.equal(enqueues.length, 1);

    // Guest 2 completes while the party is busy: the upload succeeds
    // (eligible) and a durable pending intent persists — no job, no provider
    // submit — with the guest doing nothing further.
    const req2 = await services.requestGuestUpload({
      ...guest("p-busy-2"),
      consent: { accepted: true, textVersion: GUEST_CONSENT_TEXT_VERSION, purpose: GUEST_CONSENT_PURPOSE },
      contentType: "image/jpeg",
    });
    await bucket.file(req2.objectPath).save(photo, { contentType: "image/jpeg" });
    const completed2 = await services.completeGuestUpload({ ...guest("p-busy-2"), submissionId: req2.submissionId });
    assert.equal(completed2.status, "eligible");
    const intent2 = (await db.doc(`parties/${partyId}/pendingGenerations/${req2.submissionId}`).get()).data()!;
    assert.equal(intent2.status, "pending");
    assert.equal(intent2.submissionId, req2.submissionId);
    assert.equal(intent2.consentRevision, req2.consentRevision);
    assert.ok(intent2.plan && typeof intent2.plan.scenarioId === "string");
    assert.equal((await db.doc(`parties/${partyId}/jobs/cartoon-${req2.submissionId}`).get()).exists, false);
    assert.equal(provider.videoSubmits, 0, "no provider video submit while busy");
    assert.equal(imagePort.submissions.length, 0, "no provider still submit while busy");
    assert.equal(enqueues.length, 1, "no second enqueue while busy");
    const statusPending = await services.getGuestMediaStatus({ ...guest("p-busy-2"), submissionId: req2.submissionId });
    assert.equal(statusPending.status, "eligible");
    assert.equal(statusPending.generation?.state, "pending");

    // Guest 1 finishes and releases capacity through the real worker path:
    // guest 2 is queued EXACTLY ONCE with the SAME immutable plan (no reroll).
    const run1 = await services.runGeneration({
      partyId, deviceId: "p-busy-1", channelId, jobId: job1, idempotencyKey: job1,
    });
    assert.equal(run1.state, "ready");
    assert.equal(enqueues.length, 2, "exactly one dispatch for the pending guest");
    const dispatched = enqueues[1];
    assert.equal(dispatched.jobId, `cartoon-${req2.submissionId}`);
    const job2 = (await db.doc(`parties/${partyId}/jobs/cartoon-${req2.submissionId}`).get()).data()!;
    assert.equal(job2.state, "queued");
    assert.deepEqual(job2.cartoonPlan, intent2.plan, "dispatched job must reuse the SAME immutable plan");
    assert.equal(job2.cartoonPlan.version, intent2.plan.version);
    assert.equal(job2.cartoonPlan.seed, intent2.plan.seed);
    assert.equal(job2.cartoonPlan.scenarioId, intent2.plan.scenarioId);
    assert.equal(job2.cartoonPlan.situationId, intent2.plan.situationId);
    // Re-running the worker for guest 1 changes nothing for guest 2.
    assert.equal((await db.collection(`parties/${partyId}/jobs`).get()).size, 2);
    const statusQueued = await services.getGuestMediaStatus({ ...guest("p-busy-2"), submissionId: req2.submissionId });
    assert.equal(statusQueued.generation?.state, "queued");
    assert.equal(statusQueued.generation?.jobId, `cartoon-${req2.submissionId}`);

    // Withdrawn pending never dispatches: occupy capacity again, queue a
    // third guest, then withdraw before release.
    await seedParty(db, partyId, "p-busy-3", channelId);
    await seedParty(db, partyId, "p-busy-4", channelId);
    const req3 = await uploadOnly.requestGuestUpload({
      ...guest("p-busy-3"),
      consent: { accepted: true, textVersion: GUEST_CONSENT_TEXT_VERSION, purpose: GUEST_CONSENT_PURPOSE },
      contentType: "image/jpeg",
    });
    await bucket.file(req3.objectPath).save(photo, { contentType: "image/jpeg" });
    await uploadOnly.completeGuestUpload({ ...guest("p-busy-3"), submissionId: req3.submissionId });
    // Guest 2's job is still queued (never ran): the party is still busy, so
    // guest 3's explicit occupier request must surface the typed busy outcome
    // rather than wedge — use a fresh explicit job to prove single-flight.
    await assert.rejects(
      services.requestCartoonFromPortrait({ ...guest("p-busy-3"), guestMediaId: req3.submissionId }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "BUDGET_EXCEEDED",
    );
    const req4 = await services.requestGuestUpload({
      ...guest("p-busy-4"),
      consent: { accepted: true, textVersion: GUEST_CONSENT_TEXT_VERSION, purpose: GUEST_CONSENT_PURPOSE },
      contentType: "image/jpeg",
    });
    await bucket.file(req4.objectPath).save(photo, { contentType: "image/jpeg" });
    await services.completeGuestUpload({ ...guest("p-busy-4"), submissionId: req4.submissionId });
    assert.equal((await db.doc(`parties/${partyId}/pendingGenerations/${req4.submissionId}`).get()).data()?.status, "pending");
    const enqueuesBeforeWithdraw = enqueues.length;
    await services.withdrawGuestMedia({ ...guest("p-busy-4"), submissionId: req4.submissionId });
    assert.equal((await db.doc(`parties/${partyId}/pendingGenerations/${req4.submissionId}`).get()).exists, false);
    assert.equal((await db.doc(`parties/${partyId}/jobs/cartoon-${req4.submissionId}`).get()).exists, false);
    assert.equal(enqueues.length, enqueuesBeforeWithdraw, "withdrawn pending must never dispatch");

    // Queue-admission failure is TERMINAL and visible in status (separate
    // party with a queue that always rejects).
    const partyQ = randomPartyId();
    await seedParty(db, partyQ, "p-queue-fail", channelId);
    const failing = createRuntimeServices({
      db, bucket, generationEnabled: true, provider: new FakeVideoGenerationPort(FIXTURE_DIR),
      imageProvider: new FakeImageGenerationPort(), fixtureDirectory: FIXTURE_DIR,
      enqueueGeneration: async () => { throw new Error("injected queue outage"); },
      pollIntervalMs: 1, sleep: async () => undefined,
      signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
      signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
    });
    const reqQ = await failing.requestGuestUpload({
      partyId: partyQ, deviceId: "p-queue-fail", channelId,
      consent: { accepted: true, textVersion: GUEST_CONSENT_TEXT_VERSION, purpose: GUEST_CONSENT_PURPOSE },
      contentType: "image/jpeg",
    });
    await bucket.file(reqQ.objectPath).save(photo, { contentType: "image/jpeg" });
    const completedQ = await failing.completeGuestUpload({
      partyId: partyQ, deviceId: "p-queue-fail", channelId, submissionId: reqQ.submissionId,
    });
    assert.equal(completedQ.status, "eligible", "upload stays operational through a queue outage");
    const statusQ = await failing.getGuestMediaStatus({
      partyId: partyQ, deviceId: "p-queue-fail", channelId, submissionId: reqQ.submissionId,
    });
    assert.equal(statusQ.generation?.state, "unavailable");
    assert.equal(statusQ.generation?.errorCode, "PROVIDER_UNAVAILABLE");
    await clearParty(db, bucket, partyQ);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
