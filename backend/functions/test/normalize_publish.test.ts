import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { Bucket } from "@google-cloud/storage";
import type { Firestore } from "firebase-admin/firestore";
import { BackendError } from "../src/contracts";
import { GUEST_CONSENT_PURPOSE, GUEST_CONSENT_TEXT_VERSION, REQUIRED_CAMERA_IDS } from "../src/config";
import { normalizeProviderVideo, removeNormalizedVideo } from "../src/normalize";
import { FakeVideoGenerationPort } from "../src/providers/fake";
import { createRuntimeServices } from "../src/runtime";
import { recordUsageOutcome } from "../src/usage";
import { buildCheapDemoRequest } from "../src/video_generation_port";
import {
  HAS_FIRESTORE_EMULATOR,
  clearParty,
  createEmulatorContext,
  disposeEmulatorContext,
  randomPartyId,
  seedParty,
} from "./support/emulators";

test("FFmpeg normalization produces a hashed H.264/yuv420p 24fps faststart delivery file", async () => {
  const provider = new FakeVideoGenerationPort(resolve(process.cwd(), "../../apps/tv_app/assets"));
  const request = buildCheapDemoRequest("normalize-test", "normalize-test", "CAM-01");
  const submitted = await provider.submit(request);
  const result = await provider.getResult(submitted.taskId);
  const normalized = await normalizeProviderVideo(result);
  try {
    const bytes = await readFile(normalized.path);
    assert.equal(normalized.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(normalized.sizeBytes, bytes.byteLength);
    assert.equal(normalized.durationMs, 2000);
    const moovAt = bytes.indexOf(Buffer.from("moov"));
    const mdatAt = bytes.indexOf(Buffer.from("mdat"));
    assert.ok(moovAt >= 0 && mdatAt > moovAt, "faststart places the moov atom before media data");
  } finally {
    await removeNormalizedVideo(normalized);
  }
});

test("normalization rejects provider outputs outside the locked duration/input profile", async () => {
  await assert.rejects(normalizeProviderVideo({
    video: { kind: "file", value: "/does/not/get/read.mp4" },
    secondsOut: 5,
    secondsIn: 0,
    creditsCharged: 0,
  }), /two-second text-only preset/);
  await assert.rejects(normalizeProviderVideo({
    video: { kind: "file", value: "/does/not/get/read.mp4" },
    secondsOut: 2,
    secondsIn: 1,
    creditsCharged: 0,
  }), /two-second text-only preset/);
});

function stubReferenceSigning(bucket: Bucket): void {
  // Emulator transport for reference signing: the Storage emulator cannot
  // mint real v4 signed URLs, so the worker-resolved signed https reference
  // used for the offline submit below is produced through this deterministic
  // https capability. Save/download stay on the real file object.
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

test("publish rejects withdrawn tombstones and missing consent", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "p-pub-gate";
  const channelId = "main";
  const fixtureDirectory = resolve(__dirname, "../../../apps/tv_app/assets");
  try {
    await seedParty(db, partyId, deviceId, channelId);
    stubReferenceSigning(bucket);
    const provider = new FakeVideoGenerationPort(fixtureDirectory);
    const services = createRuntimeServices({
      db, bucket, generationEnabled: true, provider, fixtureDirectory,
      enqueueGeneration: async () => undefined,
      pollIntervalMs: 1, sleep: async () => undefined,
      signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
      signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
    });
    // Eligible guest input bound to a job, staged but unpublished.
    const requested = await services.requestGuestUpload({
      partyId, deviceId, channelId,
      consent: { accepted: true, textVersion: GUEST_CONSENT_TEXT_VERSION, purpose: GUEST_CONSENT_PURPOSE },
      contentType: "image/jpeg",
    });
    const photo = await readFile(resolve(__dirname, "fixtures/guest_photo.jpg"));
    await bucket.file(requested.objectPath).save(photo, { contentType: "image/jpeg" });
    const completed = await services.completeGuestUpload({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    const jobId = "job-pub-gate";
    const idempotencyKey = "idem-pub-gate";
    await services.requestGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo", guestMediaId: requested.submissionId });
    await db.doc(`parties/${partyId}/jobs/${jobId}`).update({ state: "running", status: "running" });
    // Withdraw first: the tombstone fails the bound job and deletes the source.
    // Staged bytes are then rebuilt to simulate derivatives that survived
    // cleanup racing publication; publication must still fail closed.
    await services.withdrawGuestMedia({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    await db.doc(`parties/${partyId}/jobs/${jobId}`).update({ state: "running", status: "running" });
    // The offline submit carries the worker-resolved signed https reference
    // (resolved here through the emulator signing transport, exactly as the
    // worker's signReferenceReadUrl produces it): a bare object path is
    // rejected by the fake provider, same as the live adapter.
    // The offline submit carries the worker-resolved signed https reference
    // (resolved here through the emulator signing transport, exactly as the
    // worker's signReferenceReadUrl produces it): a bare object path is
    // rejected by the fake provider, same as the live adapter.
    const [referenceUrl] = await bucket.file(requested.objectPath).getSignedUrl({
      action: "read",
      version: "v4",
      expires: new Date(Date.now() + 15 * 60 * 1000),
    });
    assert.ok(typeof referenceUrl === "string" && referenceUrl.startsWith("https://"));
    const submitted = await provider.submit(buildCheapDemoRequest(jobId, idempotencyKey, "CAM-01", {
      objectPath: requested.objectPath, sha256: completed.sha256!, consentRevision: completed.consentRevision, url: referenceUrl,
    }));
    const result = await provider.getResult(submitted.taskId);
    await services.normalizeAndStage(partyId, jobId, "CAM-01", result);
    for (const cameraId of ["CAM-02", "CAM-03", "CAM-04"] as const) {
      const fixtureResult = await provider.getResult(`CAM-01__${"a".repeat(24)}`.replace("CAM-01", cameraId));
      await services.normalizeAndStage(partyId, jobId, cameraId, fixtureResult);
    }
    await db.doc(`parties/${partyId}/jobs/${jobId}`).update({ providerTasks: { "CAM-01": { taskId: submitted.taskId } } });
    const ledgerBase = { partyId, deviceId, channelId, manifestVersion: 1, idempotencyKey, jobId };
    await recordUsageOutcome(db, { ...ledgerBase, cameraId: "CAM-01" }, {
      success: true, secondsOut: 2, secondsIn: 0, creditsCharged: 0, providerTaskId: submitted.taskId,
    });
    for (const cameraId of ["CAM-02", "CAM-03", "CAM-04"] as const) {
      await recordUsageOutcome(db, { ...ledgerBase, cameraId }, {
        success: true, secondsOut: 2, secondsIn: 0, creditsCharged: null, providerTaskId: null, fixture: true,
      });
    }
    const tombstone = (await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).get()).data()!;
    assert.equal(tombstone.status, "withdrawn");
    assert.equal(tombstone.tombstone, true);
    // Recreate the raced eligible-on-tombstone document state that the old
    // non-transactional completion produced when it overwrote a withdrawal:
    // status eligible again, but the irreversible tombstone still set and the
    // binding fields intact. Publication must still fail closed.
    await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).update({
      status: "eligible",
      sourceHash: completed.sha256,
      sourceSizeBytes: photo.byteLength,
    });
    const raced = (await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).get()).data()!;
    assert.equal(raced.status, "eligible");
    assert.equal(raced.tombstone, true);
    await assert.rejects(services.publishManifest(partyId, jobId, idempotencyKey),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    assert.equal((await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get()).exists, false);
    // Missing consent fails closed as well.
    await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).delete();
    await assert.rejects(services.publishManifest(partyId, jobId, idempotencyKey),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    assert.ok(REQUIRED_CAMERA_IDS.length === 4);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
