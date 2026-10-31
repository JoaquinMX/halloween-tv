import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { Bucket } from "@google-cloud/storage";
import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { createDeliveryServices } from "../src/delivery";
import { REQUIRED_CAMERA_IDS, SCHEMA_VERSION } from "../src/config";
import { BackendError } from "../src/contracts";
import { createRuntimeServices } from "../src/runtime";
import { FakeVideoGenerationPort } from "../src/providers/fake";
import { HAS_FIRESTORE_EMULATOR, createEmulatorContext, clearParty, randomPartyId, seedParty, disposeEmulatorContext } from "./support/emulators";

const FIXTURE_DIR = resolve(__dirname, "../../../apps/tv_app/assets");

/**
 * Exact server-marker helper: mirrors byte-for-byte the positive
 * server-written kind:"text-only" marker that trusted creation
 * (FirestoreGenerationStore.requestGeneration for unbound jobs) stamps in
 * its creation transaction. Hand-written job docs in delivery tests use this
 * helper so the provenance gate sees the same marker production jobs carry;
 * caller-supplied kind values are never accepted at request time.
 */
function textOnlyJobDoc(job: Record<string, unknown>): Record<string, unknown> {
  return { ...job, kind: "text-only" as const };
}

function stubReferenceSigning(bucket: Bucket): void {
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

/** Upload-phase services: generation disabled so completion never auto-enqueues. */
function uploadServices(db: Firestore, bucket: Bucket) {
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

/** Full generation services with the offline fake provider. */
function generationServices(db: Firestore, bucket: Bucket) {
  stubReferenceSigning(bucket);
  return createRuntimeServices({
    db,
    bucket,
    generationEnabled: true,
    provider: new FakeVideoGenerationPort(FIXTURE_DIR),
    fixtureDirectory: FIXTURE_DIR,
    enqueueGeneration: async () => undefined,
    pollIntervalMs: 1,
    sleep: async () => undefined,
    signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
    signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
  });
}

test("delivery URLs stay inside active party scope; canonical ACK purges clips idempotently", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-1";
  const channelId = "main";
  const version = 4;
  const jobId = "job-delivery";
  const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const cameraClips = REQUIRED_CAMERA_IDS.map((cameraId) => {
    const bytes = Buffer.from(`fixture-${cameraId}`);
    return { cameraId, objectPath: `parties/${partyId}/channels/${channelId}/delivery/${version}/${cameraId}.mp4`, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, durationMs: 2000, expiresAt: expiry, bytes };
  });
  try {
    await seedParty(db, partyId, deviceId, channelId);
    await Promise.all(cameraClips.map(({ objectPath, bytes }) => bucket.file(objectPath).save(bytes, {
      metadata: { contentType: "video/mp4", metadata: { expiresAt: expiry, jobId, partyId } },
    })));
    await db.doc(`parties/${partyId}/manifests/current_${channelId}`).set({
      partyId, channelId, version, schemaVersion: SCHEMA_VERSION, jobId, expiresAt: expiry,
      createdAt: FieldValue.serverTimestamp(),
      cameraClips: cameraClips.map(({ bytes: _bytes, ...clip }) => clip),
    });
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set(textOnlyJobDoc({ jobId, partyId, deviceId, channelId, manifestVersion: version, idempotencyKey: jobId, state: "ready", deliveryPaths: cameraClips.map((clip) => clip.objectPath) }));

    const signedPaths: string[] = [];
    const services = createDeliveryServices({
      db,
      bucket,
      signReadUrl: async (file) => { signedPaths.push(file.name); return `https://signed.invalid/${encodeURIComponent(file.name)}`; },
    });
    const delivery = await services.getDeliveryUrls({ partyId, deviceId, channelId });
    assert.equal(delivery.manifestVersion, version);
    assert.deepEqual(signedPaths.sort(), cameraClips.map((clip) => clip.objectPath).sort());
    assert.ok(delivery.clips.every((clip) => clip.url.includes(encodeURIComponent(`parties/${partyId}/`))));
    const currentManifest = await services.getCurrentManifest({ partyId, deviceId, channelId });
    const repeatedManifest = await services.getCurrentManifest({ partyId, deviceId, channelId });
    assert.equal(currentManifest.createdAt, repeatedManifest.createdAt);
    assert.equal(typeof currentManifest.createdAt, "string");
    assert.deepEqual(currentManifest.cameraClips.map((clip) => clip.cameraId), [...REQUIRED_CAMERA_IDS]);
    await assert.rejects(services.getDeliveryUrls({ partyId, deviceId: "not-registered", channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");
    await assert.rejects(services.getCurrentManifest({ partyId, deviceId: "not-registered", channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");
    await assert.rejects(services.getCurrentManifest({ partyId, deviceId, channelId: "other-channel" }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");
    await db.doc(`parties/${partyId}/devices/${deviceId}`).update({ status: "disabled" });
    await assert.rejects(services.getCurrentManifest({ partyId, deviceId, channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");
    await db.doc(`parties/${partyId}/devices/${deviceId}`).update({ status: "active" });
    await db.doc(`parties/${partyId}`).update({ status: "inactive" });
    await assert.rejects(services.getCurrentManifest({ partyId, deviceId, channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");
    await db.doc(`parties/${partyId}`).update({ status: "active" });
    await db.doc(`parties/${partyId}/channels/${channelId}`).update({ status: "inactive" });
    await assert.rejects(services.getCurrentManifest({ partyId, deviceId, channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");
    await db.doc(`parties/${partyId}/channels/${channelId}`).update({ status: "active" });

    const invalidHashes = Object.fromEntries(cameraClips.map((clip) => [clip.cameraId, clip.sha256]));
    invalidHashes["CAM-01"] = "f".repeat(64);
    await assert.rejects(services.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: version, clipHashes: invalidHashes }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "MANIFEST_MISMATCH");

    const clipHashes = Object.fromEntries(cameraClips.map((clip) => [clip.cameraId, clip.sha256]));
    await assert.rejects(services.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: version - 1, clipHashes }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "MANIFEST_MISMATCH");
    const ack = await services.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: version, clipHashes });
    assert.equal(ack.purged, true);
    assert.equal((await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()?.state, "purged");
    for (const clip of cameraClips) assert.equal((await bucket.file(clip.objectPath).exists())[0], false);
    const repeated = await services.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: version, clipHashes });
    assert.equal(repeated.ackId, ack.ackId);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("two-camera manifest delivers, ACKs exactly, and rejects extra hashes", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-2cam";
  const channelId = "main";
  const version = 2;
  const jobId = "job-two-cam";
  const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const cameraIds = ["CAM-01", "CAM-02"] as const;
  const cameraClips = cameraIds.map((cameraId) => {
    const bytes = Buffer.from(`two-cam-${cameraId}`);
    return { cameraId, objectPath: `parties/${partyId}/channels/${channelId}/delivery/${version}/${cameraId}.mp4`, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, durationMs: 2000, expiresAt: expiry, bytes };
  });
  try {
    await seedParty(db, partyId, deviceId, channelId);
    await Promise.all(cameraClips.map(({ objectPath, bytes }) => bucket.file(objectPath).save(bytes)));
    await db.doc(`parties/${partyId}/manifests/current_${channelId}`).set({
      partyId, channelId, version, schemaVersion: SCHEMA_VERSION, jobId, expiresAt: expiry,
      createdAt: FieldValue.serverTimestamp(),
      cameraClips: cameraClips.map(({ bytes: _bytes, ...clip }) => clip),
    });
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set(textOnlyJobDoc({ jobId, partyId, deviceId, channelId, manifestVersion: version, idempotencyKey: jobId, state: "ready" }));
    const services = createDeliveryServices({
      db,
      bucket,
      signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
    });
    const delivery = await services.getDeliveryUrls({ partyId, deviceId, channelId });
    assert.equal(delivery.manifestVersion, version);
    assert.deepEqual(delivery.clips.map((clip) => clip.cameraId).sort(), ["CAM-01", "CAM-02"]);
    const current = await services.getCurrentManifest({ partyId, deviceId, channelId });
    assert.equal(current.cameraClips.length, 2);
    const clipHashes = Object.fromEntries(cameraClips.map((clip) => [clip.cameraId, clip.sha256]));
    // Extra hashes beyond the received prefix are rejected, nothing purged.
    await assert.rejects(services.acknowledgeDelivery({
      partyId, deviceId, channelId, manifestVersion: version,
      clipHashes: { ...clipHashes, "CAM-03": "c".repeat(64) },
    }), (error: unknown) => error instanceof BackendError && error.errorCode === "MANIFEST_MISMATCH");
    assert.equal((await bucket.file(cameraClips[0].objectPath).exists())[0], true);
    const ack = await services.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: version, clipHashes });
    assert.equal(ack.purged, true);
    for (const clip of cameraClips) assert.equal((await bucket.file(clip.objectPath).exists())[0], false);
    // Legacy four-camera ACK shape against a two-camera manifest is rejected.
    await assert.rejects(services.acknowledgeDelivery({
      partyId, deviceId, channelId, manifestVersion: version,
      clipHashes: { ...clipHashes, "CAM-03": "c".repeat(64), "CAM-04": "d".repeat(64) },
    }), (error: unknown) => error instanceof BackendError && error.errorCode === "MANIFEST_MISMATCH");
    const repeated = await services.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: version, clipHashes });
    assert.equal(repeated.ackId, ack.ackId);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("expired canonical clip does not receive a signed URL", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-1";
  const channelId = "main";
  const version = 1;
  const jobId = "job-expired";
  const expired = new Date(Date.now() - 1000).toISOString();
  const cameraClips = REQUIRED_CAMERA_IDS.map((cameraId) => ({
    cameraId,
    objectPath: `parties/${partyId}/channels/${channelId}/delivery/${version}/${cameraId}.mp4`,
    sha256: createHash("sha256").update(cameraId).digest("hex"),
    sizeBytes: 1,
    durationMs: 2000,
    expiresAt: expired,
  }));
  try {
    await seedParty(db, partyId, deviceId, channelId);
    await db.doc(`parties/${partyId}/manifests/current_${channelId}`).set({ partyId, channelId, version, schemaVersion: 1, jobId, expiresAt: expired, cameraClips });
    const services = createDeliveryServices({ db, bucket, signReadUrl: async () => "https://unused.invalid" });
    await assert.rejects(services.getDeliveryUrls({ partyId, deviceId, channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "CLIP_EXPIRED");
    const clipHashes = Object.fromEntries(cameraClips.map((clip) => [clip.cameraId, clip.sha256]));
    await assert.rejects(services.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: version, clipHashes }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "CLIP_EXPIRED");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("accepted ACK retries its bounded version after partial purge, expiry, and publication advances", {
  skip: !HAS_FIRESTORE_EMULATOR,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-ack-retry";
  const channelId = "main";
  const version = 1;
  const nextVersion = 2;
  const jobId = "job-ack-retry";
  const oldExpiry = "2026-10-29T16:00:00.000Z";
  const now = { value: Date.parse("2026-10-29T15:00:00.000Z") };
  const clipsFor = (clipVersion: number, expiresAt: string) => REQUIRED_CAMERA_IDS.map((cameraId) => {
    const bytes = Buffer.from(`${clipVersion}-${cameraId}`);
    return {
      cameraId,
      objectPath: `parties/${partyId}/channels/${channelId}/delivery/${clipVersion}/${cameraId}.mp4`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
      durationMs: 2000,
      expiresAt,
      bytes,
    };
  });
  const oldClips = clipsFor(version, oldExpiry);
  const newClips = clipsFor(nextVersion, "2026-11-29T16:00:00.000Z");
  let failedOnce = false;
  const failingPath = oldClips[0].objectPath;
  try {
    await seedParty(db, partyId, deviceId, channelId);
    await Promise.all(oldClips.map(({ objectPath, bytes }) => bucket.file(objectPath).save(bytes)));
    await Promise.all(newClips.map(({ objectPath, bytes }) => bucket.file(objectPath).save(bytes)));
    const currentRef = db.doc(`parties/${partyId}/manifests/current_${channelId}`);
    await currentRef.set({
      partyId, channelId, version, schemaVersion: SCHEMA_VERSION, jobId, expiresAt: oldExpiry,
      cameraClips: oldClips.map(({ bytes: _bytes, ...clip }) => clip),
    });
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set(textOnlyJobDoc({ jobId, partyId, deviceId, channelId, state: "ready" }));
    const services = createDeliveryServices({
      db,
      bucket,
      now: () => new Date(now.value),
      deleteDeliveryObject: async (file) => {
        if (file.name === failingPath && !failedOnce) {
          failedOnce = true;
          throw new Error("injected partial purge failure");
        }
        await file.delete({ ignoreNotFound: true });
      },
    });
    const clipHashes = Object.fromEntries(oldClips.map((clip) => [clip.cameraId, clip.sha256]));
    await assert.rejects(services.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: version, clipHashes }));
    assert.equal((await bucket.file(failingPath).exists())[0], true);
    assert.equal((await bucket.file(oldClips[1].objectPath).exists())[0], false);
    const ackId = (await db.collection(`parties/${partyId}/deliveryAcks`).get()).docs[0]?.id;
    assert.ok(ackId);

    await currentRef.set({
      partyId, channelId, version: nextVersion, schemaVersion: SCHEMA_VERSION, jobId: "job-new-version",
      expiresAt: "2026-11-29T16:00:00.000Z",
      cameraClips: newClips.map(({ bytes: _bytes, ...clip }) => clip),
    });
    now.value = Date.parse("2026-10-30T17:00:00.000Z");
    const conflictingHashes = { ...clipHashes, "CAM-01": "f".repeat(64) };
    await assert.rejects(services.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: version, clipHashes: conflictingHashes }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "MANIFEST_MISMATCH");

    const repeated = await services.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: version, clipHashes });
    assert.equal(repeated.ackId, ackId);
    for (const clip of oldClips) assert.equal((await bucket.file(clip.objectPath).exists())[0], false);
    for (const clip of newClips) assert.equal((await bucket.file(clip.objectPath).exists())[0], true);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("a manifest bound to withdrawn consent yields no delivery URLs even while it lingers", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "p-guest-1";
  const channelId = "main";
  const jobId = "job-revoked-consent";
  const idempotencyKey = "idem-revoked-consent";
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const upload = uploadServices(db, bucket);
    const gen = generationServices(db, bucket);
    // Realistic trusted path: the job is created by requestGeneration with a
    // consent-bound guestMediaId (server-stamped binding), runs through the
    // prod worker to a published manifest, and delivers — all before the
    // withdrawal lands.
    const requested = await upload.requestGuestUpload({
      partyId, deviceId, channelId,
      consent: { accepted: true, textVersion: "v1", purpose: "guest_cameo" }, contentType: "image/jpeg",
    });
    const photo = await readFile(resolve(__dirname, "fixtures/guest_photo.jpg"));
    await bucket.file(requested.objectPath).save(photo, { contentType: "image/jpeg" });
    await upload.completeGuestUpload({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    await gen.requestGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo", guestMediaId: requested.submissionId });
    const run = await gen.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey });
    assert.equal(run.state, "ready");
    const baseline = await gen.getDeliveryUrls({ partyId, deviceId, channelId });
    assert.equal(baseline.clips.length, 4);
    // REAL withdrawal through the prod path (not a hand-written tombstone):
    // eligibility is revoked, derivatives purged, the job failed closed.
    const withdrawn = await gen.withdrawGuestMedia({ partyId, deviceId, channelId, submissionId: requested.submissionId });
    assert.equal(withdrawn.status, "withdrawn");
    assert.equal((await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()?.state, "failed");
    // WITHDRAWAL denial: the manifest is revoked at withdrawal (deleted
    // alongside the derivatives), the job fails closed, and no new delivery
    // can be issued from the withdrawn binding.
    const failedJob = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()!;
    assert.equal(failedJob.state, "failed");
    assert.equal(failedJob.errorCode, "FORBIDDEN");
    assert.equal((await db.doc(`parties/${partyId}/guestMedia/${requested.submissionId}`).get()).data()?.status, "withdrawn");
    assert.equal((await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get()).exists, false);
    await assert.rejects(gen.getDeliveryUrls({ partyId, deviceId, channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "MANIFEST_MISMATCH");
    await assert.rejects(gen.getCurrentManifest({ partyId, deviceId, channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "NOT_FOUND");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("a hand-written unbound job doc stays denied: absence of binding never authorizes", {
  skip: !HAS_FIRESTORE_EMULATOR,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-1";
  const channelId = "main";
  const version = 1;
  const jobId = "job-unbound-handwritten";
  const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const cameraClips = REQUIRED_CAMERA_IDS.map((cameraId) => {
    const bytes = Buffer.from(`unbound-${cameraId}`);
    return { cameraId, objectPath: `parties/${partyId}/channels/${channelId}/delivery/${version}/${cameraId}.mp4`, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, durationMs: 2000, expiresAt: expiry, bytes };
  });
  try {
    await seedParty(db, partyId, deviceId, channelId);
    await Promise.all(cameraClips.map(({ objectPath, bytes }) => bucket.file(objectPath).save(bytes)));
    // Hand-written doc with NO binding and NO server marker: delivery must
    // fail closed even though the manifest shape is valid.
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set({
      jobId, partyId, deviceId, channelId, manifestVersion: version, idempotencyKey: jobId, state: "ready",
    });
    await db.doc(`parties/${partyId}/manifests/current_${channelId}`).set({
      partyId, channelId, version, schemaVersion: SCHEMA_VERSION, jobId, expiresAt: expiry,
      createdAt: FieldValue.serverTimestamp(),
      cameraClips: cameraClips.map(({ bytes: _bytes, ...clip }) => clip),
    });
    const services = createDeliveryServices({ db, bucket, signReadUrl: async () => "https://unused.invalid" });
    await assert.rejects(services.getDeliveryUrls({ partyId, deviceId, channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "MANIFEST_MISMATCH");
    await assert.rejects(services.getCurrentManifest({ partyId, deviceId, channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "MANIFEST_MISMATCH");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("approved legacy/operator/host seed delivers without mobile consent; denials stay explicit", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-legacy";
  const channelId = "main";
  const version = 1;
  const jobId = "job-legacy-seed";
  const seedId = "legacy-seed-1";
  const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const cameraClips = REQUIRED_CAMERA_IDS.map((cameraId) => {
    const bytes = Buffer.from(`legacy-${cameraId}`);
    return { cameraId, objectPath: `parties/${partyId}/channels/${channelId}/delivery/${version}/${cameraId}.mp4`, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, durationMs: 2000, expiresAt: expiry, bytes };
  });
  try {
    await seedParty(db, partyId, deviceId, channelId);
    await Promise.all(cameraClips.map(({ objectPath, bytes }) => bucket.file(objectPath).save(bytes)));
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set({
      jobId, partyId, deviceId, channelId, manifestVersion: version, idempotencyKey: jobId, state: "ready",
      seedProvenance: { seedId, kind: "legacy" },
    });
    await db.doc(`parties/${partyId}/seedVideos/${seedId}`).set({
      seedId, partyId, channelId, jobId, status: "ready", operatorApproved: true, expiresAt: expiry,
    });
    await db.doc(`parties/${partyId}/manifests/current_${channelId}`).set({
      partyId, channelId, version, schemaVersion: SCHEMA_VERSION, jobId, expiresAt: expiry,
      createdAt: FieldValue.serverTimestamp(),
      cameraClips: cameraClips.map(({ bytes: _bytes, ...clip }) => clip),
    });
    const services = createDeliveryServices({ db, bucket, signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}` });
    // Reproduced wall stall resolved at its backend cause: the scoped
    // provenance gate authorizes this explicitly supported legacy artifact.
    const delivery = await services.getDeliveryUrls({ partyId, deviceId, channelId });
    assert.equal(delivery.manifestVersion, version);
    const current = await services.getCurrentManifest({ partyId, deviceId, channelId });
    assert.equal(current.version, version);
    // Withdrawn / deleted / expired / unknown / unauthorized bindings deny explicitly.
    await db.doc(`parties/${partyId}/seedVideos/${seedId}`).update({ status: "withdrawn" });
    await assert.rejects(services.getDeliveryUrls({ partyId, deviceId, channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");
    await db.doc(`parties/${partyId}/seedVideos/${seedId}`).update({ status: "ready" });
    await db.doc(`parties/${partyId}/seedVideos/${seedId}`).update({ status: "deleted" });
    await assert.rejects(services.getCurrentManifest({ partyId, deviceId, channelId }),
      (error: unknown) => error instanceof BackendError && (error.errorCode === "NOT_FOUND" || error.errorCode === "FORBIDDEN"));
    await db.doc(`parties/${partyId}/seedVideos/${seedId}`).delete();
    await assert.rejects(services.getDeliveryUrls({ partyId, deviceId, channelId }),
      (error: unknown) => error instanceof BackendError && (error.errorCode === "NOT_FOUND" || error.errorCode === "FORBIDDEN"));
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("unreadable authorization evidence fails closed, never fail-open", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-fail-closed";
  const channelId = "main";
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const { evaluateDeliveryProvenance } = await import("../src/contracts");
    const guestJob = { partyId, channelId, jobId: "job-x", guestMedia: { submissionId: "gsub-x", sourceHash: "a".repeat(64), consentRevision: "v1:t" } };
    // Simulated Firestore read failure must surface INTERNAL, not a silent pass.
    assert.throws(() => evaluateDeliveryProvenance({ job: guestJob, guest: undefined, guestReadError: new Error("firestore down"), nowMs: Date.now() }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "INTERNAL" && /authorization/.test(error.message));
    await disposeEmulatorContext(app);
  } catch (error) {
    await disposeEmulatorContext(app);
    throw error;
  } finally {
    const { getFirestore } = await import("firebase-admin/firestore");
    void getFirestore;
    await clearParty(db, bucket, partyId).catch(() => undefined);
  }
});
