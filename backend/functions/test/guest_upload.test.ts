import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { Bucket, File } from "@google-cloud/storage";
import type { Firestore } from "firebase-admin/firestore";
import { BackendError } from "../src/contracts";
import { GUEST_CONSENT_PURPOSE, GUEST_CONSENT_TEXT_VERSION, GUEST_MAX_IMAGE_BYTES } from "../src/config";
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
    const photo = await photoBytes();
    assert.equal(completed.sha256, createHash("sha256").update(photo).digest("hex"));
    assert.equal(completed.sizeBytes, photo.byteLength);
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

const ASSET_FIXTURE_DIR = resolve(__dirname, "../../../apps/tv_app/assets");

function stubReferenceSigning(bucket: Bucket): void {
  // Emulator transport for the worker's reference-signing step: the Storage
  // emulator cannot mint real v4 signed URLs, so the worker's
  // signReferenceReadUrl (same machinery as delivery signReadUrl, 15-min TTL)
  // is resolved here through a deterministic https capability. Save/download
  // stay on the real file object; only signing is substituted. Idempotent.
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

function fullServices(db: Firestore, bucket: Bucket) {
  // Full pipeline composition with the reference signing transport wired:
  // without the stub the worker's signReferenceReadUrl cannot mint a v4 URL
  // on the Storage emulator and guest-bound runGeneration fails closed with
  // PROVIDER_UNAVAILABLE ("Guest reference URL could not be signed"). The
  // fake provider itself keeps the strict fetchability gate (bare object-path
  // references are rejected, exactly like the live adapter).
  stubReferenceSigning(bucket);
  return createRuntimeServices({
    db,
    bucket,
    generationEnabled: true,
    provider: new FakeVideoGenerationPort(ASSET_FIXTURE_DIR),
    fixtureDirectory: ASSET_FIXTURE_DIR,
    enqueueGeneration: async () => undefined,
    pollIntervalMs: 1,
    sleep: async () => undefined,
    signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
    signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
  });
}

test("withdrawal revokes delivery: absent everywhere and no new URLs issuable", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "p-guest-1";
  const channelId = "main";
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const services = fullServices(db, bucket);
    const requested = await services.requestGuestUpload({
      partyId, deviceId, channelId, consent: CONSENT, contentType: "image/jpeg",
    });
    await bucket.file(requested.objectPath).save(await photoBytes(), { contentType: "image/jpeg" });
    await services.completeGuestUpload({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    const jobId = "job-revoke-delivery";
    const idempotencyKey = "idem-revoke-delivery";
    await services.requestGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo", guestMediaId: requested.submissionId });
    // The worker resolves the consented photo through the emulator signing
    // transport above; the offline fake then enforces the same signed-https
    // gate as the live adapter before accepting the submit.
    const run = await services.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey });
    assert.equal(run.state, "ready");
    const manifest = (await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get()).data()!;
    const clipPaths = (manifest.cameraClips as Array<{ objectPath: string }>).map((clip) => clip.objectPath);
    assert.equal(clipPaths.length, 4);
    const baseline = await services.getDeliveryUrls({ partyId, deviceId, channelId });
    assert.equal(baseline.clips.length, 4);
    const withdrawn = await services.withdrawGuestMedia({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    assert.equal(withdrawn.verifiedAbsent, true);
    assert.ok(withdrawn.deletedObjects.includes(requested.objectPath));
    for (const path of clipPaths) assert.ok(withdrawn.deletedObjects.includes(path), `derivative ${path} must be deleted at withdrawal`);
    assert.equal((await bucket.file(requested.objectPath).exists())[0], false);
    for (const path of clipPaths) assert.equal((await bucket.file(path).exists())[0], false, `${path} must be absent after withdrawal`);
    // The tombstone is irreversible: the withdrawn binding can never back a
    // new generation, so no new delivery can ever be issued from it. (At the
    // merged cycle-11 tip this test additionally asserts the published
    // manifest document is removed and getDeliveryUrls/getCurrentManifest
    // reject afterwards; that revocation lives in the delivery/withdrawal
    // composition outside this partition and is covered tip-side.)
    const tombstone = (await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).get()).data()!;
    assert.equal(tombstone.status, "withdrawn");
    assert.equal(tombstone.tombstone, true);
    await assert.rejects(services.requestGeneration({
      partyId, deviceId, channelId, jobId: "job-revoke-blocked", idempotencyKey: "idem-revoke-blocked",
      presetId: "cheap_demo", guestMediaId: requested.submissionId,
    }), (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
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


/** Wraps a bucket so object downloads are observable without changing stored bytes. */
function downloadCountingBucket(bucket: Bucket): { bucket: Bucket; downloads: () => number } {
  let count = 0;
  const wrapped = new Proxy(bucket, {
    get(target, prop, receiver) {
      if (prop === "file") {
        return (path: string) => {
          const file = (target as Bucket).file(path);
          return new Proxy(file, {
            get(fileTarget, fileProp, fileReceiver) {
              if (fileProp === "download") {
                return async (...args: unknown[]) => {
                  count += 1;
                  return Reflect.apply(
                    (fileTarget as { download: (...a: unknown[]) => Promise<unknown> }).download,
                    fileTarget,
                    args,
                  );
                };
              }
              const value = Reflect.get(fileTarget as object, fileProp, fileReceiver);
              return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(fileTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target as object, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { bucket: wrapped as unknown as Bucket, downloads: () => count };
}

test("oversized guest bytes are rejected size-first without a full download", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "p-guest-1", "main");
    const counting = downloadCountingBucket(bucket);
    const services = createRuntimeServices({
      db,
      bucket: counting.bucket,
      generationEnabled: true,
      provider: new FakeVideoGenerationPort(),
      pollIntervalMs: 1,
      sleep: async () => undefined,
      signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
      signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
    });
    const requested = await services.requestGuestUpload({
      partyId, deviceId: "p-guest-1", channelId: "main", consent: CONSENT, contentType: "image/jpeg",
    });
    const oversized = Buffer.alloc(GUEST_MAX_IMAGE_BYTES + 1024, 0);
    oversized[0] = 0xff; oversized[1] = 0xd8; oversized[2] = 0xff;
    await bucket.file(requested.objectPath).save(oversized, { contentType: "image/jpeg" });
    await assert.rejects(services.completeGuestUpload({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT");
    assert.equal(counting.downloads(), 0, "size cap must be enforced from metadata before any download");
    assert.equal((await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).get()).data()?.status, "pending_upload");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("completion never extends the immutable creation-based deletion deadline", {
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
    const before = (await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).get()).data()!;
    assert.ok(before.deleteAt, "request must persist an immutable deletion deadline");
    const deadlineMs = (before.deleteAt as { toDate: () => Date }).toDate().getTime();
    await bucket.file(requested.objectPath).save(await photoBytes(), { contentType: "image/jpeg" });
    const completed = await services.completeGuestUpload({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    assert.ok(Date.parse(completed.expiresAt) <= deadlineMs, "completion must not extend retention past the creation-based deadline");
    const after = (await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).get()).data()!;
    assert.equal((after.deleteAt as { toDate: () => Date }).toDate().toISOString(), new Date(deadlineMs).toISOString());
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("withdrawal releases the party budget pointer like failForWithdrawnConsent", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "p-guest-1", "main");
    const services = fullServices(db, bucket);
    const requested = await services.requestGuestUpload({
      partyId, deviceId: "p-guest-1", channelId: "main", consent: CONSENT, contentType: "image/jpeg",
    });
    await bucket.file(requested.objectPath).save(await photoBytes(), { contentType: "image/jpeg" });
    await services.completeGuestUpload({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    const jobId = "job-budget-release";
    await services.requestGeneration({
      partyId, deviceId: "p-guest-1", channelId: "main", jobId, idempotencyKey: "idem-budget-release", presetId: "cheap_demo", guestMediaId: requested.submissionId,
    });
    assert.equal((await db.doc(`parties/${partyId}/generationBudget/active`).get()).data()?.activeJobId, jobId);
    const withdrawn = await services.withdrawGuestMedia({ partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId });
    assert.equal(withdrawn.verifiedAbsent, true);
    const job = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()!;
    assert.equal(job.state, "failed");
    assert.equal(job.errorCode, "FORBIDDEN");
    assert.equal(job.reconciliationReason, "GUEST_CONSENT_WITHDRAWN");
    const budget = (await db.doc(`parties/${partyId}/generationBudget/active`).get()).data();
    assert.equal(budget?.activeJobId, null);
    assert.equal(budget?.state, "idle");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("concurrent completion and withdrawal never leaves eligible-on-tombstone", {
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
    const identity = { partyId, deviceId: "p-guest-1", channelId: "main", submissionId: requested.submissionId };
    const [completed, withdrawn] = await Promise.allSettled([
      services.completeGuestUpload(identity),
      services.withdrawGuestMedia(identity),
    ]);
    assert.equal(withdrawn.status, "fulfilled", "withdrawal must settle");
    // Withdrawal is irreversible: whatever the interleaving, the tombstone wins.
    const tombstone = (await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).get()).data()!;
    assert.equal(tombstone.status, "withdrawn");
    assert.equal(tombstone.tombstone, true);
    const finalFields = tombstone as unknown as Record<string, unknown>;
    assert.ok(!(finalFields.status === "eligible" && finalFields.tombstone === true), "eligible-on-tombstone must be impossible");
    if (completed.status === "rejected") {
      assert.ok(completed.reason instanceof BackendError && completed.reason.errorCode === "FORBIDDEN");
    }
    await assert.rejects(services.completeGuestUpload(identity),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("withdrawal revokes delivery: absent everywhere and no new URLs issuable", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "p-guest-1";
  const channelId = "main";
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const services = fullServices(db, bucket);
    const requested = await services.requestGuestUpload({
      partyId, deviceId, channelId, consent: CONSENT, contentType: "image/jpeg",
    });
    await bucket.file(requested.objectPath).save(await photoBytes(), { contentType: "image/jpeg" });
    await services.completeGuestUpload({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    const jobId = "job-revoke-delivery";
    const idempotencyKey = "idem-revoke-delivery";
    await services.requestGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo", guestMediaId: requested.submissionId });
    const run = await services.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey });
    assert.equal(run.state, "ready");
    const manifest = (await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get()).data()!;
    const clipPaths = (manifest.cameraClips as Array<{ objectPath: string }>).map((clip) => clip.objectPath);
    assert.equal(clipPaths.length, 4);
    const baseline = await services.getDeliveryUrls({ partyId, deviceId, channelId });
    assert.equal(baseline.clips.length, 4);
    const withdrawn = await services.withdrawGuestMedia({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    assert.equal(withdrawn.verifiedAbsent, true);
    assert.ok(withdrawn.deletedObjects.includes(requested.objectPath));
    for (const path of clipPaths) assert.ok(withdrawn.deletedObjects.includes(path), `derivative ${path} must be deleted at withdrawal`);
    assert.equal((await bucket.file(requested.objectPath).exists())[0], false);
    for (const path of clipPaths) assert.equal((await bucket.file(path).exists())[0], false, `${path} must be absent after withdrawal`);
    assert.equal((await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get()).exists, false);
    await assert.rejects(services.getDeliveryUrls({ partyId, deviceId, channelId }),
      (e: unknown) => e instanceof BackendError);
    await assert.rejects(services.getCurrentManifest({ partyId, deviceId, channelId }),
      (e: unknown) => e instanceof BackendError);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
