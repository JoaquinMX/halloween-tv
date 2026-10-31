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

test("runtime selects the fake provider from the environment and serves packaged fixtures", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { mkdtempSync, rmSync, copyFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-packaged-fixtures";
  const channelId = "main";
  const jobId = "job-packaged-fixtures";
  const idempotencyKey = "idem-packaged-fixtures";
  // Isolated packaged fixture directory: byte copies of the prepared
  // runtime/fixtures, with no access to the repository asset directory.
  const packaged = mkdtempSync(join(tmpdir(), "runtime-packaged-fixtures-"));
  const previousProvider = process.env.VIDEO_GENERATION_PROVIDER;
  try {
    process.env.VIDEO_GENERATION_PROVIDER = "fake";
    mkdirSync(packaged, { recursive: true });
    for (const cameraId of REQUIRED_CAMERA_IDS) {
      const name = `cam${cameraId.slice(-2).toLowerCase()}.mp4`;
      copyFileSync(resolve(process.cwd(), "runtime", "fixtures", name), join(packaged, name));
    }
    await seedParty(db, partyId, deviceId, channelId);
    const tasks: Array<{ partyId: string; deviceId: string; channelId: string; jobId: string; idempotencyKey: string }> = [];
    const services = createRuntimeServices({
      db,
      bucket,
      generationEnabled: true,
      // No explicit provider: selection comes from VIDEO_GENERATION_PROVIDER
      // and the packaged directory, exactly like the deployed composition.
      fixtureDirectory: packaged,
      enqueueGeneration: async (task) => { tasks.push(task); },
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    const request = await services.requestGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo" });
    assert.deepEqual(request, { jobId, state: "queued", created: true });
    assert.equal(tasks.length, 1);
    assert.deepEqual(await services.runGeneration(tasks[0]), { jobId, state: "ready", manifestVersion: 1 });
    const manifest = await services.getCurrentManifest({ partyId, deviceId, channelId });
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.cameraClips.map((clip) => clip.cameraId), [...REQUIRED_CAMERA_IDS]);
    // The pipeline normalizes packaged fixture bytes to the generated-shape
    // profile, so manifest hashes are the normalized outputs (probed below),
    // not the raw fixture bytes — but every byte must trace to the packaged
    // directory through the fake provider.
    const { spawnSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    for (const clip of manifest.cameraClips) {
      const [objectBytes] = await bucket.file(clip.objectPath).download();
      assert.equal(objectBytes.byteLength, clip.sizeBytes);
      assert.equal(createHash("sha256").update(objectBytes).digest("hex"), clip.sha256);
      const tmpClip = join(packaged, `retained-${clip.cameraId}.mp4`);
      writeFileSync(tmpClip, objectBytes);
      const result = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=codec_name,pix_fmt,r_frame_rate,width,height:format=duration", "-of", "json", tmpClip],
      { encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 0, result.stderr);
      const metadata = JSON.parse(result.stdout) as {
        streams: Array<{ codec_name: string; pix_fmt: string; r_frame_rate: string; width: number; height: number }>;
        format: { duration: string };
      };
      assert.equal(metadata.streams[0].codec_name, "h264", `normalized delivery codec for ${clip.cameraId}`);
      assert.equal(metadata.streams[0].pix_fmt, "yuv420p");
      assert.equal(metadata.streams[0].r_frame_rate, "24/1");
      assert.equal(metadata.streams[0].width, 854);
      assert.equal(metadata.streams[0].height, 480);
      assert.equal(Math.round(Number(metadata.format.duration) * 1000), 2000);
    }
    for (const cameraId of REQUIRED_CAMERA_IDS) {
      const ledger = (await db.doc(`parties/${partyId}/costLogs/${usageLedgerId(jobId, cameraId)}`).get()).data();
      assert.equal(ledger?.success, true);
      assert.equal(ledger?.credits_charged, 0, `fake provider must record synthetic zero for ${cameraId}`);
    }
    assert.deepEqual(await reconcileUsage(db), []);
    // The packaged directory is load-bearing: an empty directory fails the
    // same job closed instead of falling back to the repository assets.
    const emptyDir = mkdtempSync(join(tmpdir(), "runtime-empty-fixtures-"));
    try {
      const emptyServices = createRuntimeServices({
        db,
        bucket,
        generationEnabled: true,
        fixtureDirectory: emptyDir,
        enqueueGeneration: async () => undefined,
        pollIntervalMs: 1,
        sleep: async () => undefined,
      });
      await emptyServices.requestGeneration({
        partyId, deviceId, channelId,
        jobId: "job-empty-fixtures", idempotencyKey: "idem-empty-fixtures", presetId: "cheap_demo",
      });
      await assert.rejects(
        emptyServices.runGeneration({ partyId, deviceId, channelId, jobId: "job-empty-fixtures", idempotencyKey: "idem-empty-fixtures" }),
        (error: unknown) => error instanceof BackendError && error.errorCode === "PROVIDER_UNAVAILABLE",
      );
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  } finally {
    if (previousProvider === undefined) delete process.env.VIDEO_GENERATION_PROVIDER;
    else process.env.VIDEO_GENERATION_PROVIDER = previousProvider;
    rmSync(packaged, { recursive: true, force: true });
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("runtime rejects an unknown provider selection instead of silently substituting", {
  skip: !HAS_FIRESTORE_EMULATOR,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const previousProvider = process.env.VIDEO_GENERATION_PROVIDER;
  try {
    await seedParty(db, partyId, "tv-bad-provider", "main");
    process.env.VIDEO_GENERATION_PROVIDER = "bogus-live-provider";
    const services = createRuntimeServices({
      db,
      bucket,
      generationEnabled: true,
      enqueueGeneration: async () => undefined,
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    await services.requestGeneration({
      partyId, deviceId: "tv-bad-provider", channelId: "main",
      jobId: "job-bad-provider", idempotencyKey: "idem-bad-provider", presetId: "cheap_demo",
    });
    // Unknown providers fail closed as PROVIDER_UNAVAILABLE: no silent
    // substitution, no live call, no fabricated task ID.
    await assert.rejects(
      services.runGeneration({ partyId, deviceId: "tv-bad-provider", channelId: "main", jobId: "job-bad-provider", idempotencyKey: "idem-bad-provider" }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "PROVIDER_UNAVAILABLE",
    );
    const failed = (await db.doc(`parties/${partyId}/jobs/job-bad-provider`).get()).data();
    assert.ok(failed?.state === "running" || failed?.state === "queued" || failed?.state === "failed",
      `failed-closed job must not reach ready (state=${String(failed?.state)})`);
    assert.deepEqual(failed?.providerTasks ?? {}, {});
    const ledger = (await db.doc(`parties/${partyId}/costLogs/${usageLedgerId("job-bad-provider", "CAM-01")}`).get()).data();
    assert.equal(ledger?.success, false);
    assert.equal(ledger?.provider_task_id, null, "no fabricated provider task ID for an unresolvable provider");
  } finally {
    if (previousProvider === undefined) delete process.env.VIDEO_GENERATION_PROVIDER;
    else process.env.VIDEO_GENERATION_PROVIDER = previousProvider;
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
