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
import {
  HAS_FIRESTORE_EMULATOR,
  clearParty,
  createEmulatorContext,
  disposeEmulatorContext,
  randomPartyId,
  seedParty,
} from "./support/emulators";

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
