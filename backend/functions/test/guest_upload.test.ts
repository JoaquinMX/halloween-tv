import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { Bucket, File } from "@google-cloud/storage";
import type { Firestore } from "firebase-admin/firestore";
import { BackendError } from "../src/contracts";
import { GUEST_CONSENT_PURPOSE, GUEST_CONSENT_TEXT_VERSION } from "../src/config";
import { createRuntimeServices } from "../src/runtime";
import { FakeVideoGenerationPort } from "../src/providers/fake";
import { sweepExpiredMedia } from "../src/retention";
import {
  HAS_FIRESTORE_EMULATOR,
  clearParty,
  createEmulatorContext,
  disposeEmulatorContext,
  randomPartyId,
  seedParty,
} from "./support/emulators";

const CONSENT = { accepted: true, textVersion: GUEST_CONSENT_TEXT_VERSION, purpose: GUEST_CONSENT_PURPOSE };

async function photoBytes(): Promise<Buffer> {
  return readFile(resolve(__dirname, "fixtures/guest_photo.jpg"));
}

function servicesFor(db: Firestore, bucket: Bucket, overrides: {
  deleteGuestObject?: (file: File) => Promise<void>;
} = {}) {
  return createRuntimeServices({
    db,
    bucket,
    generationEnabled: true,
    provider: new FakeVideoGenerationPort(),
    pollIntervalMs: 1,
    sleep: async () => undefined,
    // Emulator transport substitute: the Storage emulator cannot mint real v4
    // signed URLs, so tests inject a deterministic capability string. This is
    // NOT equivalent to cloud IAM signing; it only proves the backend returns
    // a per-submission capability without persisting it.
    signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
    signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
    ...overrides,
  });
}

test("requestGuestUpload refuses missing consent, bad consent, and caller-supplied paths", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "p-guest-1", "main");
    const services = servicesFor(db, bucket);
    const base = { partyId, deviceId: "p-guest-1", channelId: "main", contentType: "image/jpeg" };
    await assert.rejects(services.requestGuestUpload({ ...base }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    await assert.rejects(services.requestGuestUpload({ ...base, consent: { accepted: false, textVersion: "v1", purpose: "guest_cameo" } }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    await assert.rejects(services.requestGuestUpload({ ...base, consent: { accepted: true, textVersion: "v9", purpose: "guest_cameo" } }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT");
    await assert.rejects(services.requestGuestUpload({ ...base, consent: { accepted: true, textVersion: "v1", purpose: "other" } }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT");
    await assert.rejects(services.requestGuestUpload({ ...base, consent: CONSENT, contentType: "image/gif" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT");
    await assert.rejects(
      services.requestGuestUpload({ ...base, consent: CONSENT, objectPath: "parties/x/guests/y/ingest/z/photo.jpg" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT");
    await assert.rejects(services.requestGuestUpload({ ...base, consent: CONSENT, deviceId: "not-registered" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("guest upload completes against real bytes and repeats idempotently", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "p-guest-1", "main");
    const services = servicesFor(db, bucket);
    const requested = await services.requestGuestUpload({
      partyId, deviceId: "p-guest-1", channelId: "main", consent: CONSENT, contentType: "image/jpeg",
    });
    assert.ok(requested.submissionId);
    assert.ok(requested.objectPath.startsWith(`parties/${partyId}/guests/p-guest-1/ingest/${requested.submissionId}/`));
    assert.ok(requested.uploadUrl.includes(encodeURIComponent(requested.objectPath)));
    assert.equal(requested.consentRevision, "v1:" + (await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).get()).data()?.consent.acceptedAt);
    // The signed PUT capability is returned, never persisted.
    const stored = (await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).get()).data()!;
    assert.equal(stored.status, "pending_upload");
    assert.ok(!("uploadUrl" in stored) && !JSON.stringify(stored).includes("upload.invalid"));
    // Simulate the PUT through the issued capability with real image bytes.
    await bucket.file(requested.objectPath).save(await photoBytes(), { contentType: "image/jpeg" });
    const completed = await services.completeGuestUpload({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    assert.equal(completed.status, "eligible");
    assert.equal(completed.sha256, stored.sourceHash ?? completed.sha256);
    assert.ok(/^[a-f0-9]{64}$/.test(completed.sha256!));
    assert.ok((completed.sizeBytes ?? 0) > 0);
    const repeated = await services.completeGuestUpload({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    assert.deepEqual(repeated, completed);
    const status = await services.getGuestMediaStatus({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    assert.equal(status.status, "eligible");
    assert.equal(status.sha256, completed.sha256);
    assert.ok(!("uploadUrl" in status));
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("guest media is scoped: cross-device and cross-party access is refused", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "p-guest-1", "main");
    await seedParty(db, partyId, "p-guest-2", "main");
    const services = servicesFor(db, bucket);
    const requested = await services.requestGuestUpload({
      partyId, deviceId: "p-guest-1", channelId: "main", consent: CONSENT, contentType: "image/jpeg",
    });
    await assert.rejects(services.getGuestMediaStatus({ partyId, deviceId: "p-guest-2", channelId: "main", submissionId: requested.submissionId }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    await assert.rejects(services.completeGuestUpload({ partyId, deviceId: "p-guest-2", channelId: "main", submissionId: requested.submissionId }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    await assert.rejects(services.withdrawGuestMedia({ partyId, deviceId: "p-guest-2", channelId: "main", submissionId: requested.submissionId }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    await assert.rejects(services.getGuestMediaStatus({ partyId: "other-party", deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId }),
      (e: unknown) => e instanceof BackendError && (e.errorCode === "FORBIDDEN" || e.errorCode === "NOT_FOUND"));
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("withdrawal is idempotent, deletes the source, and verifies absence", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "p-guest-1", "main");
    const services = servicesFor(db, bucket);
    const requested = await services.requestGuestUpload({
      partyId, deviceId: "p-guest-1", channelId: "main", consent: CONSENT, contentType: "image/jpeg",
    });
    await bucket.file(requested.objectPath).save(await photoBytes(), { contentType: "image/jpeg" });
    await services.completeGuestUpload({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    const withdrawn = await services.withdrawGuestMedia({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    assert.equal(withdrawn.status, "withdrawn");
    assert.equal(withdrawn.verifiedAbsent, true);
    assert.ok(withdrawn.deletedObjects.includes(requested.objectPath));
    assert.equal((await bucket.file(requested.objectPath).exists())[0], false);
    const repeated = await services.withdrawGuestMedia({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    assert.equal(repeated.status, "withdrawn");
    assert.equal((await bucket.file(requested.objectPath).exists())[0], false);
    const tombstone = (await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).get()).data()!;
    assert.equal(tombstone.status, "withdrawn");
    assert.equal(tombstone.tombstone, true);
    // Withdrawn media can never become eligible again.
    await assert.rejects(services.completeGuestUpload({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("PUT after withdrawal never restores eligibility and is deleted", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "p-guest-1", "main");
    const services = servicesFor(db, bucket);
    const requested = await services.requestGuestUpload({
      partyId, deviceId: "p-guest-1", channelId: "main", consent: CONSENT, contentType: "image/jpeg",
    });
    await bucket.file(requested.objectPath).save(await photoBytes(), { contentType: "image/jpeg" });
    await services.completeGuestUpload({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    await services.withdrawGuestMedia({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    // Late PUT through the stale capability.
    await bucket.file(requested.objectPath).save(await photoBytes(), { contentType: "image/jpeg" });
    assert.equal((await bucket.file(requested.objectPath).exists())[0], true);
    const cleanup = await services.handleGuestIngestFinalized(requested.objectPath);
    assert.deepEqual(cleanup, { handled: true, deleted: true });
    assert.equal((await bucket.file(requested.objectPath).exists())[0], false);
    const status = await services.getGuestMediaStatus({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    assert.equal(status.status, "withdrawn");
    await assert.rejects(services.completeGuestUpload({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("withdrawal retries a failed delete and verifies absence", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "p-guest-1", "main");
    let deletes = 0;
    const services = servicesFor(db, bucket, {
      deleteGuestObject: async (file: { delete: (o?: object) => Promise<unknown> }) => {
        deletes += 1;
        if (deletes === 1) throw new Error("injected deletion failure");
        await file.delete({ ignoreNotFound: true });
      },
    });
    const requested = await services.requestGuestUpload({
      partyId, deviceId: "p-guest-1", channelId: "main", consent: CONSENT, contentType: "image/jpeg",
    });
    await bucket.file(requested.objectPath).save(await photoBytes(), { contentType: "image/jpeg" });
    await services.completeGuestUpload({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    const withdrawn = await services.withdrawGuestMedia({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    assert.equal(withdrawn.verifiedAbsent, true);
    assert.ok(deletes >= 2, `expected a retried delete, saw ${deletes}`);
    assert.equal((await bucket.file(requested.objectPath).exists())[0], false);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("retention protects pending uploads and removes abandoned inputs within 24h", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "p-guest-1", "main");
    const services = servicesFor(db, bucket);
    const live = await services.requestGuestUpload({
      partyId, deviceId: "p-guest-1", channelId: "main", consent: CONSENT, contentType: "image/jpeg",
    });
    await bucket.file(live.objectPath).save(await photoBytes(), { contentType: "image/jpeg" });
    // Abandoned pending upload whose window lapsed (written directly to set a past expiry).
    const abandonedId = "gsub-abandoned000000000000000001";
    const abandonedPath = `parties/${partyId}/guests/p-guest-1/ingest/${abandonedId}/photo.jpg`;
    await db.doc(`parties/${partyId}/guestMedia/${abandonedId}`).set({
      submissionId: abandonedId,
      partyId,
      deviceId: "p-guest-1",
      channelId: "main",
      status: "pending_upload",
      consent: { accepted: true, textVersion: "v1", purpose: "guest_cameo", acceptedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), deviceId: "p-guest-1" },
      consentRevision: "v1:abandoned",
      objectPath: abandonedPath,
      contentType: "image/jpeg",
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    await bucket.file(abandonedPath).save(await photoBytes(), { contentType: "image/jpeg" });
    const result = await sweepExpiredMedia(db, bucket, new Date());
    assert.ok(result.expiredGuestInputs >= 1);
    assert.equal((await bucket.file(live.objectPath).exists())[0], true);
    assert.equal((await bucket.file(abandonedPath).exists())[0], false);
    assert.equal((await db.doc(`parties/${partyId}/guestMedia/${abandonedId}`).get()).data()?.status, "expired");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("withdrawn media refuses future generation", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "p-guest-1", "main");
    const services = servicesFor(db, bucket);
    const requested = await services.requestGuestUpload({
      partyId, deviceId: "p-guest-1", channelId: "main", consent: CONSENT, contentType: "image/jpeg",
    });
    await bucket.file(requested.objectPath).save(await photoBytes(), { contentType: "image/jpeg" });
    await services.completeGuestUpload({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    await services.withdrawGuestMedia({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    await assert.rejects(services.requestGeneration({
      partyId, deviceId: "p-guest-1", channelId: "main",
      jobId: "job-refused", idempotencyKey: "idem-refused", presetId: "cheap_demo", guestMediaId: requested.submissionId,
    }), (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    await assert.rejects(services.requestGeneration({
      partyId, deviceId: "p-guest-1", channelId: "main",
      jobId: "job-unknown-guest", idempotencyKey: "idem-unknown-guest", presetId: "cheap_demo", guestMediaId: "gsub-doesnotexist00000000000001",
    }), (e: unknown) => e instanceof BackendError && (e.errorCode === "NOT_FOUND" || e.errorCode === "FORBIDDEN"));
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
