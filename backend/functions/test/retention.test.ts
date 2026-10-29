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
