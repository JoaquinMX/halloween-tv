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
    await assert.rejects(services.getDeliveryUrls({ partyId, deviceId: "not-registered", channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");

    const invalidHashes = Object.fromEntries(cameraClips.map((clip) => [clip.cameraId, clip.sha256]));
    invalidHashes["CAM-01"] = "f".repeat(64);
    await assert.rejects(services.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: version, clipHashes: invalidHashes }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "MANIFEST_MISMATCH");

    const clipHashes = Object.fromEntries(cameraClips.map((clip) => [clip.cameraId, clip.sha256]));
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
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
