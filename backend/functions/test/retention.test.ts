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

test("host seed previews are protected while live and purged after expiry", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const livePath = `parties/${partyId}/hostPreviews/seed-live/CAM-01.mp4`;
  const deadPath = `parties/${partyId}/hostPreviews/seed-dead/CAM-01.mp4`;
  try {
    await seedParty(db, partyId, "tv-1", "main");
    await db.doc(`parties/${partyId}/seedVideos/seed-live`).set({
      seedId: "seed-live", partyId, channelId: "main", jobId: "hv-seed-live",
      status: "ready", previewPaths: [livePath],
      expiresAt: Timestamp.fromDate(new Date(Date.now() + 60 * 60 * 1000)),
    });
    await db.doc(`parties/${partyId}/seedVideos/seed-dead`).set({
      seedId: "seed-dead", partyId, channelId: "main", jobId: "hv-seed-dead",
      status: "ready", previewPaths: [deadPath],
      expiresAt: Timestamp.fromDate(new Date(Date.now() - 1000)),
    });
    await bucket.file(livePath).save(Buffer.from("live-preview"));
    await bucket.file(deadPath).save(Buffer.from("dead-preview"));
    const result = await sweepExpiredMedia(db, bucket, new Date());
    assert.equal((await bucket.file(livePath).exists())[0], true, "live seed previews must be protected from the orphan sweep");
    assert.equal((await bucket.file(deadPath).exists())[0], false, "expired seed previews must be purged");
    assert.equal((await db.doc(`parties/${partyId}/seedVideos/seed-dead`).get()).data()?.status, "expired");
    assert.ok(result.deletedOrphanObjects >= 1);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("lapsed host invites expire via the sweep (Firestore TTL policy defense-in-depth)", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "tv-1", "main");
    const past = Timestamp.fromDate(new Date(Date.now() - 1000));
    const future = Timestamp.fromDate(new Date(Date.now() + 60 * 60 * 1000));
    await db.doc(`parties/${partyId}/hostInvites/deadbeefdeadbeefdeadbeefdeadbeef`).set({
      inviteId: "deadbeefdeadbeefdeadbeefdeadbeef",
      tokenHash: "a".repeat(64),
      pairingCodeHash: "b".repeat(64),
      pairingSalt: "c".repeat(32),
      partyId, channelId: "main", status: "pending", createdByDevice: "tv-1", usedByDevice: null, expiresAt: past,
    });
    await db.doc(`parties/${partyId}/hostInvites/livefeedlivefeedlivefeedlivefeed`).set({
      inviteId: "livefeedlivefeedlivefeedlivefeed",
      tokenHash: "d".repeat(64),
      pairingCodeHash: "e".repeat(64),
      pairingSalt: "f".repeat(32),
      partyId, channelId: "main", status: "pending", createdByDevice: "tv-1", usedByDevice: null, expiresAt: future,
    });
    await sweepExpiredMedia(db, bucket, new Date());
    assert.equal((await db.doc(`parties/${partyId}/hostInvites/deadbeefdeadbeefdeadbeefdeadbeef`).get()).data()?.status, "expired");
    assert.equal((await db.doc(`parties/${partyId}/hostInvites/livefeedlivefeedlivefeedlivefeed`).get()).data()?.status, "pending");
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

test("retention projection covers stills and intermediates while excluding accounting", async () => {
  const { retentionPathsForJob } = await import("../src/retention");
  const { collectJobDerivativePaths } = await import("../src/guest_media");
  const job = {
    deliveryPaths: ["parties/p/channels/c/delivery/1/CAM-01.mp4"],
    generatedPaths: ["parties/p/channels/c/generated/x.mp4"],
    stillPaths: ["parties/p/stills/cartoon-final.png"],
    intermediatePaths: ["parties/p/intermediates/diffuse-1.bin"],
    previewPaths: ["parties/p/hostPreviews/seed-1/CAM-01.mp4"],
    cartoonStillPath: "parties/p/stills/cartoon-final.png",
    stagedOutputs: {
      "CAM-01": { cameraId: "CAM-01", objectPath: "parties/p/channels/c/delivery/1/CAM-02.mp4", sha256: "a".repeat(64) },
    },
  };
  const retained = retentionPathsForJob(job);
  const collected = collectJobDerivativePaths(job as Record<string, unknown>);
  for (const expected of [
    "parties/p/channels/c/delivery/1/CAM-01.mp4",
    "parties/p/channels/c/generated/x.mp4",
    "parties/p/stills/cartoon-final.png",
    "parties/p/intermediates/diffuse-1.bin",
    "parties/p/hostPreviews/seed-1/CAM-01.mp4",
    "parties/p/channels/c/delivery/1/CAM-02.mp4",
  ]) {
    assert.ok(retained.includes(expected), `retention must track ${expected}`);
    assert.ok(collected.includes(expected), `withdrawal/host-deletion must track ${expected}`);
  }
  assert.deepEqual([...new Set(retained)].length, retained.length, "retention projection must not duplicate paths");
});

test("sweep purges expired stills and intermediates yet never extends retention limits", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const channelId = "main";
  const jobId = "job-still-expiry";
  const dueIso = new Date(Date.now() - 10_000).toISOString();
  const due = new Date(dueIso);
  const deliveryPath = `parties/${partyId}/channels/${channelId}/delivery/1/CAM-01.mp4`;
  const stillPath = `parties/${partyId}/stills/expired-cartoon.png`;
  const intermediatePath = `parties/${partyId}/intermediates/expired-diffuse.bin`;
  const liveStill = `parties/${partyId}/stills/live-cartoon.png`;
  try {
    await seedParty(db, partyId, "tv-1", channelId);
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set({
      jobId, partyId, deviceId: "tv-1", channelId, state: "ready", manifestVersion: 1,
      expiresAt: Timestamp.fromDate(due),
      deliveryPaths: [deliveryPath], generatedPaths: [],
      stillPaths: [stillPath], intermediatePaths: [intermediatePath],
    });
    await bucket.file(deliveryPath).save(Buffer.from("expired-delivery"));
    await bucket.file(stillPath).save(Buffer.from("expired-still"));
    await bucket.file(intermediatePath).save(Buffer.from("expired-intermediate"));
    // A live job's still is a shared catalog reference and must survive.
    await db.doc(`parties/${partyId}/jobs/job-live`).set({
      jobId: "job-live", partyId, deviceId: "tv-1", channelId, state: "ready", manifestVersion: 2,
      expiresAt: Timestamp.fromDate(new Date(Date.now() + 60 * 60 * 1000)),
      deliveryPaths: [], generatedPaths: [], stillPaths: [liveStill],
    });
    await bucket.file(liveStill).save(Buffer.from("live-still"));
    const result = await sweepExpiredMedia(db, bucket, new Date());
    assert.ok(result.expiredJobs >= 1);
    assert.equal((await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()?.state, "expired");
    assert.equal((await bucket.file(deliveryPath).exists())[0], false);
    assert.equal((await bucket.file(stillPath).exists())[0], false, "expired cartoon still must be purged");
    assert.equal((await bucket.file(intermediatePath).exists())[0], false, "expired intermediate must be purged");
    assert.equal((await bucket.file(liveStill).exists())[0], true, "live shared still reference must be protected");
    // The sweep marks expiry; it never extends the stored deadline.
    const expiredAt = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()?.expiresAt;
    assert.equal(expiredAt.toDate().toISOString(), dueIso, "immutable retention limit must not move");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
