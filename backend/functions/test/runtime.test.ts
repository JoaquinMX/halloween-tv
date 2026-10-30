import assert from "node:assert/strict";
import test from "node:test";
import { Firestore } from "firebase-admin/firestore";
import { Bucket } from "@google-cloud/storage";
import { BackendError } from "../src/contracts";
import { isGenerationEnabled, REQUIRED_CAMERA_IDS } from "../src/config";
import { createRuntimeServices } from "../src/runtime";
import { FakeVideoGenerationPort } from "../src/providers/fake";
import { usageLedgerId, reconcileUsage } from "../src/usage";
import { HAS_FIRESTORE_EMULATOR, clearParty, createEmulatorContext, disposeEmulatorContext, randomPartyId, seedParty } from "./support/emulators";

test("runtime defaults generation off and requires an explicit enable switch", async () => {
  assert.equal(isGenerationEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(isGenerationEnabled({ GENERATION_ENABLED: "true" } as NodeJS.ProcessEnv), true);
  const services = createRuntimeServices({ db: {} as Firestore, bucket: {} as Bucket });
  await assert.rejects(services.requestGeneration({}),
    (error: unknown) => error instanceof BackendError && error.errorCode === "PROVIDER_UNAVAILABLE");

  const previousProvider = process.env.VIDEO_GENERATION_PROVIDER;
  try {
    process.env.VIDEO_GENERATION_PROVIDER = "alibaba";
    const discovered = createRuntimeServices({ db: {} as Firestore, bucket: {} as Bucket, generationEnabled: true });
    assert.equal(typeof discovered.runGeneration, "function");
  } finally {
    if (previousProvider === undefined) delete process.env.VIDEO_GENERATION_PROVIDER;
    else process.env.VIDEO_GENERATION_PROVIDER = previousProvider;
  }
});

test("runtime records a queue failure and releases the generation budget", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-queue-failure";
  const channelId = "main";
  const jobId = "job-queue-failure";
  const idempotencyKey = "idem-queue-failure";
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const services = createRuntimeServices({
      db,
      bucket,
      generationEnabled: true,
      provider: new FakeVideoGenerationPort(),
      enqueueGeneration: async () => { throw new Error("queue unavailable"); },
    });
    await assert.rejects(services.requestGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo" }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "PROVIDER_UNAVAILABLE");
    const job = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data();
    const budget = (await db.doc(`parties/${partyId}/generationBudget/active`).get()).data();
    assert.equal(job?.state, "failed");
    assert.equal(job?.status, "failed");
    assert.equal(job?.errorCode, "PROVIDER_UNAVAILABLE");
    assert.ok(job?.enqueueFailedAt);
    assert.equal(budget?.state, "idle");
    assert.equal(budget?.activeJobId, null);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("exported-handler runtime composition publishes four offline clips and usage records once", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-runtime-fake";
  const channelId = "main";
  const jobId = "job-runtime-fake";
  const idempotencyKey = "idem-runtime-fake";
  const tasks: Array<{ partyId: string; deviceId: string; channelId: string; jobId: string; idempotencyKey: string }> = [];
  let submissions = 0;
  class TrackingFakeProvider extends FakeVideoGenerationPort {
    override async submit(request: Parameters<FakeVideoGenerationPort["submit"]>[0]) {
      submissions += 1;
      return super.submit(request);
    }
  }

  try {
    await seedParty(db, partyId, deviceId, channelId);
    const services = createRuntimeServices({
      db,
      bucket,
      generationEnabled: true,
      provider: new TrackingFakeProvider(),
      enqueueGeneration: async (task) => { tasks.push(task); },
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    const input = { partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo" };
    const request = await services.requestGeneration(input);
    const duplicate = await services.requestGeneration(input);
    assert.deepEqual(request, { jobId, state: "queued", created: true });
    assert.deepEqual(duplicate, { jobId, state: "queued", created: false });
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0], { partyId, deviceId, channelId, jobId, idempotencyKey });

    assert.deepEqual(await services.runGeneration(tasks[0]), { jobId, state: "ready", manifestVersion: 1 });
    assert.deepEqual(await services.runGeneration(tasks[0]), { jobId, state: "ready", manifestVersion: 1 });
    assert.equal(submissions, REQUIRED_CAMERA_IDS.length);

    const manifest = await services.getCurrentManifest({ partyId, deviceId, channelId });
    assert.equal(manifest.version, 1);
    assert.equal(typeof manifest.createdAt, "string");
    assert.deepEqual(manifest.cameraClips.map((clip) => clip.cameraId), [...REQUIRED_CAMERA_IDS]);
    for (const cameraId of REQUIRED_CAMERA_IDS) {
      const ledger = (await db.doc(`parties/${partyId}/costLogs/${usageLedgerId(jobId, cameraId)}`).get()).data();
      assert.equal(ledger?.partyId, partyId);
      assert.equal(ledger?.deviceId, deviceId);
      assert.equal(ledger?.channelId, channelId);
      assert.equal(ledger?.manifestVersion, 1);
      assert.equal(ledger?.idempotencyKey, idempotencyKey);
      assert.equal(ledger?.success, true);
      assert.equal(typeof ledger?.provider_task_id, "string");
    }
    assert.deepEqual(await reconcileUsage(db), []);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
