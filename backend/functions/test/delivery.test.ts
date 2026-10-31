import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { FieldValue } from "firebase-admin/firestore";
import { createDeliveryServices } from "../src/delivery";
import { REQUIRED_CAMERA_IDS, SCHEMA_VERSION } from "../src/config";
import { BackendError } from "../src/contracts";
import { HAS_FIRESTORE_EMULATOR, createEmulatorContext, clearParty, randomPartyId, seedParty, disposeEmulatorContext } from "./support/emulators";

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
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set({ jobId, partyId, deviceId, channelId, manifestVersion: version, idempotencyKey: jobId, state: "ready", deliveryPaths: cameraClips.map((clip) => clip.objectPath) });

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
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set({ jobId, partyId, deviceId, channelId, manifestVersion: version, idempotencyKey: jobId, state: "ready" });
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
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set({ jobId, partyId, deviceId, channelId, state: "ready" });
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
  skip: !HAS_FIRESTORE_EMULATOR,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-1";
  const channelId = "main";
  const version = 1;
  const jobId = "job-revoked-consent";
  const submissionId = "gsub-revoked000000000000000001";
  const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const cameraClips = REQUIRED_CAMERA_IDS.map((cameraId) => {
    const bytes = Buffer.from(`revoked-${cameraId}`);
    return { cameraId, objectPath: `parties/${partyId}/channels/${channelId}/delivery/${version}/${cameraId}.mp4`, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, durationMs: 2000, expiresAt: expiry, bytes };
  });
  try {
    await seedParty(db, partyId, deviceId, channelId);
    await Promise.all(cameraClips.map(({ objectPath, bytes }) => bucket.file(objectPath).save(bytes)));
    // Guest-bound job whose consent was withdrawn after publication; the
    // manifest document itself has not been collected yet.
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set({
      jobId, partyId, deviceId, channelId, manifestVersion: version, idempotencyKey: jobId, state: "failed",
      guestMedia: { submissionId, objectPath: `parties/${partyId}/guests/${deviceId}/ingest/${submissionId}/photo.jpg`, sourceHash: "a".repeat(64), consentRevision: "v1:revoked", deviceId, channelId },
    });
    await db.doc(`parties/${partyId}/guestMedia/${submissionId}`).set({
      submissionId, partyId, deviceId, channelId, status: "withdrawn", tombstone: true,
      consentRevision: "v1:revoked", objectPath: `parties/${partyId}/guests/${deviceId}/ingest/${submissionId}/photo.jpg`,
    });
    await db.doc(`parties/${partyId}/manifests/current_${channelId}`).set({
      partyId, channelId, version, schemaVersion: SCHEMA_VERSION, jobId, expiresAt: expiry,
      createdAt: FieldValue.serverTimestamp(),
      cameraClips: cameraClips.map(({ bytes: _bytes, ...clip }) => clip),
    });
    const services = createDeliveryServices({ db, bucket, signReadUrl: async () => "https://unused.invalid" });
    await assert.rejects(services.getDeliveryUrls({ partyId, deviceId, channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");
    await assert.rejects(services.getCurrentManifest({ partyId, deviceId, channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");
    // Control: the same manifest shape without a guest binding still serves.
    await db.doc(`parties/${partyId}/jobs/${jobId}`).update({ guestMedia: FieldValue.delete() });
    const delivery = await services.getDeliveryUrls({ partyId, deviceId, channelId });
    assert.equal(delivery.manifestVersion, version);
    assert.equal(delivery.clips.length, 4);
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
