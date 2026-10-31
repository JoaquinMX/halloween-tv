import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { sweepExpiredMedia } from "../src/retention";
import { HAS_FIRESTORE_EMULATOR, createEmulatorContext, clearParty, randomPartyId, seedParty, disposeEmulatorContext } from "./support/emulators";

test("TTL sweep expires due jobs, deletes expired media, and removes orphan objects", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-1";
  const channelId = "main";
  const jobId = "job-expire";
  const due = new Date(Date.now() - 10_000);
  const dueIso = due.toISOString();
  const objectPath = `parties/${partyId}/channels/${channelId}/delivery/1/CAM-01.mp4`;
  const orphanPath = `parties/${partyId}/ingest/orphan.bin`;
  try {
    await seedParty(db, partyId, deviceId, channelId);
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set({
      jobId, partyId, deviceId, channelId, state: "ready", manifestVersion: 1,
      expiresAt: Timestamp.fromDate(due), deliveryPaths: [objectPath], generatedPaths: [],
    });
    await bucket.file(objectPath).save(Buffer.from("expired"), { metadata: { metadata: { expiresAt: dueIso, jobId } } });
    await bucket.file(orphanPath).save(Buffer.from("orphan"));
    await db.doc(`parties/${partyId}/manifests/current_${channelId}`).set({
      partyId, channelId, version: 1, jobId, expiresAt: dueIso,
      cameraClips: [{ cameraId: "CAM-01", objectPath, sha256: createHash("sha256").update("expired").digest("hex"), sizeBytes: 7, durationMs: 2000, expiresAt: dueIso }],
    });
    const result = await sweepExpiredMedia(db, bucket, new Date());
    assert.ok(result.expiredJobs >= 1, `expected at least this party's due job to expire (got ${result.expiredJobs}); suite shares one emulator across files`);
    assert.equal((await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()?.state, "expired");
    assert.equal((await bucket.file(objectPath).exists())[0], false);
    assert.equal((await bucket.file(orphanPath).exists())[0], false);
    assert.ok(result.deletedOrphanObjects >= 1);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("revoked-manifest objects are retried for deletion, never protected", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-1";
  const channelId = "main";
  const jobId = "job-revoked";
  const submissionId = "gsub-revoked000000000000000002";
  const liveExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const clipPath = `parties/${partyId}/channels/${channelId}/delivery/1/CAM-01.mp4`;
  const sourcePath = `parties/${partyId}/guests/${deviceId}/ingest/${submissionId}/photo.jpg`;
  try {
    await seedParty(db, partyId, deviceId, channelId);
    // Withdrawn tombstone whose manifest was published before withdrawal and
    // whose source object survived the withdrawal delete (pending retry).
    await db.doc(`parties/${partyId}/guestMedia/${submissionId}`).set({
      submissionId, partyId, deviceId, channelId, status: "withdrawn", tombstone: true,
      consentRevision: "v1:revoked", objectPath: sourcePath,
      pendingDeletions: [sourcePath], revokedManifestPaths: [clipPath],
      withdrawnAt: new Date().toISOString(),
    });
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set({
      jobId, partyId, deviceId, channelId, state: "failed", errorCode: "FORBIDDEN",
      manifestVersion: 1, expiresAt: Timestamp.fromDate(new Date(Date.now() + 60 * 60 * 1000)),
      guestMedia: { submissionId },
    });
    await db.doc(`parties/${partyId}/manifests/current_${channelId}`).set({
      partyId, channelId, version: 1, schemaVersion: 1, jobId, expiresAt: liveExpiry,
      cameraClips: [{ cameraId: "CAM-01", objectPath: clipPath, sha256: createHash("sha256").update("revoked").digest("hex"), sizeBytes: 7, durationMs: 2000, expiresAt: liveExpiry }],
    });
    await bucket.file(clipPath).save(Buffer.from("revoked"));
    await bucket.file(sourcePath).save(Buffer.from("leftover-source"));
    assert.equal((await bucket.file(clipPath).exists())[0], true);
    const result = await sweepExpiredMedia(db, bucket, new Date());
    assert.equal((await bucket.file(clipPath).exists())[0], false, "revoked manifest clip must be deleted, not protected");
    assert.equal((await bucket.file(sourcePath).exists())[0], false, "pending withdrawal deletions must be retried");
    assert.ok(result.deletedOrphanObjects >= 2, `expected revoked objects to be retried (got ${JSON.stringify(result)})`);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
