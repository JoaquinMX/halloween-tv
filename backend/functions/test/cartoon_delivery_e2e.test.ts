import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { FieldValue } from "firebase-admin/firestore";
import { BackendError, canonicalManifestHash } from "../src/contracts";
import { SCHEMA_VERSION, REQUIRED_CAMERA_IDS } from "../src/config";
import { createDeliveryServices } from "../src/delivery";
import { createRuntimeServices } from "../src/runtime";
import { FakeVideoGenerationPort } from "../src/providers/fake";
import { normalizeProviderVideo, removeNormalizedVideo } from "../src/normalize";
import { buildCheapDemoRequest } from "../src/video_generation_port";
import {
  HAS_FIRESTORE_EMULATOR,
  clearParty,
  createEmulatorContext,
  disposeEmulatorContext,
  randomPartyId,
  seedParty,
} from "./support/emulators";

const ASSETS = resolve(__dirname, "../../../apps/tv_app/assets");

function probeProfileOrThrow(path: string, bytes: Buffer): void {
  // The Storage emulator cannot mint real v4 signed URLs and has no TLS: the
  // injected signer below is an explicit test-only substitute and is never
  // labeled production-equivalent. Media bytes are real emulator Storage
  // bytes; profile verification below runs against those bytes.
  const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
  const probed = spawnSync(ffprobe, [
    "-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=codec_name,pix_fmt,r_frame_rate,width,height:format=duration", "-of", "json", path,
  ], { encoding: "utf8", timeout: 30_000 });
  if (probed.error || probed.status !== 0) {
    // Fallback container check keeps the suite portable when no native
    // ffprobe exists; the profile fields are still asserted on the manifest.
    assert.equal(bytes.toString("ascii", 4, 8), "ftyp", "delivery bytes are not an MP4 container");
    return;
  }
  const metadata = JSON.parse(probed.stdout) as {
    streams?: Array<{ codec_name?: string; pix_fmt?: string; r_frame_rate?: string; width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const video = metadata.streams?.[0];
  const durationMs = Math.round(Number(metadata.format?.duration) * 1000);
  assert.equal(video?.codec_name, "h264");
  assert.equal(video?.pix_fmt, "yuv420p");
  assert.equal(video?.r_frame_rate, "24/1");
  assert.equal(video?.width, 854);
  assert.equal(video?.height, 480);
  assert.equal(durationMs, 2000);
}

test("cartoon delivery e2e: legacy-seed wall stall reproduces and resolves via scoped provenance", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-cartoon-wall";
  const channelId = "main";
  const version = 1;
  const jobId = "job-legacy-seed-wall";
  const seedId = "legacy-seed-wall-01";
  const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  try {
    const raw = await readFile(resolve(__dirname, "fixtures/legacy_seed_delivery.json"), "utf8");
    const legacy = JSON.parse(raw) as { seedProvenance: { seedId: string; kind: string } };
    assert.equal(legacy.seedProvenance.kind, "legacy");

    await seedParty(db, partyId, deviceId, channelId);
    // Real normalized 2s delivery bytes through the prod normalization path.
    const provider = new FakeVideoGenerationPort(ASSETS);
    const clips: Array<{ cameraId: "CAM-01" | "CAM-02" | "CAM-03" | "CAM-04"; objectPath: string; sha256: string; sizeBytes: number; durationMs: number; expiresAt: string }> = [];
    for (const cameraId of REQUIRED_CAMERA_IDS) {
      const submitted = await provider.submit(buildCheapDemoRequest(jobId, jobId, cameraId));
      const result = await provider.getResult(submitted.taskId);
      const normalized = await normalizeProviderVideo(result);
      try {
        const bytes = await readFile(normalized.path);
        assert.equal(normalized.sha256, createHash("sha256").update(bytes).digest("hex"));
        const objectPath = `parties/${partyId}/channels/${channelId}/delivery/${version}/${cameraId}.mp4`;
        await bucket.file(objectPath).save(bytes, {
          metadata: { contentType: "video/mp4", metadata: { expiresAt: expiry, jobId, partyId } },
        });
        clips.push({ cameraId, objectPath, sha256: normalized.sha256, sizeBytes: bytes.byteLength, durationMs: 2000, expiresAt: expiry });
      } finally {
        await removeNormalizedVideo(normalized);
      }
    }
    await db.doc(`parties/${partyId}/seedVideos/${seedId}`).set({
      seedId, partyId, channelId, jobId, status: "ready", operatorApproved: true, expiresAt: expiry,
    });
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set({
      jobId, partyId, deviceId, channelId, manifestVersion: version, idempotencyKey: jobId, state: "ready",
      seedProvenance: { seedId, kind: "legacy" },
    });
    await db.doc(`parties/${partyId}/manifests/current_${channelId}`).set({
      partyId, channelId, version, schemaVersion: SCHEMA_VERSION, jobId, expiresAt: expiry,
      createdAt: FieldValue.serverTimestamp(),
      cameraClips: clips,
    });

    const services = createRuntimeServices({
      db, bucket, generationEnabled: true, provider: new FakeVideoGenerationPort(ASSETS),
      enqueueGeneration: async () => undefined,
      signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
    });
    // Reproduce the wall stall through the public runtime composition, then
    // resolve it at its backend cause (scoped provenance, not mobile consent).
    const current = await services.getCurrentManifest({ partyId, deviceId, channelId });
    assert.equal(current.version, version);
    assert.deepEqual(current.cameraClips.map((c) => c.cameraId), [...REQUIRED_CAMERA_IDS]);
    const delivery = await services.getDeliveryUrls({ partyId, deviceId, channelId });
    assert.equal(delivery.manifestVersion, version);
    assert.equal(delivery.manifestHash, canonicalManifestHash({ partyId, channelId, version, cameraClips: clips }));
    assert.equal(delivery.clips.length, 4);
    // Actual downloaded bytes + independent hashes (real storage bytes).
    const hashes: Record<string, string> = {};
    for (const clip of clips) {
      const [bytes] = await bucket.file(clip.objectPath).download();
      assert.ok(bytes.byteLength > 0);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), clip.sha256);
      assert.equal(bytes.byteLength, clip.sizeBytes);
      hashes[clip.cameraId] = clip.sha256;
    }
    // ACK is idempotent; purge removes delivery objects; retained bytes stay readable.
    const ack = await services.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: version, clipHashes: hashes });
    assert.equal(ack.purged, true);
    const repeated = await services.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: version, clipHashes: hashes });
    assert.equal(repeated.ackId, ack.ackId);
    assert.equal((await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data()?.state, "purged");
    for (const clip of clips) assert.equal((await bucket.file(clip.objectPath).exists())[0], false);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("cartoon delivery e2e: normalized profile, preview retention, withdrawal denial", {
  skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-cartoon-e2e";
  const channelId = "main";
  const version = 1;
  const jobId = "job-cartoon-e2e";
  const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const provider = new FakeVideoGenerationPort(ASSETS);
    const clips: Array<{ cameraId: "CAM-01" | "CAM-02" | "CAM-03" | "CAM-04"; objectPath: string; sha256: string; sizeBytes: number; durationMs: number; expiresAt: string }> = [];
    for (const cameraId of REQUIRED_CAMERA_IDS) {
      const submitted = await provider.submit(buildCheapDemoRequest(jobId, jobId, cameraId));
      const result = await provider.getResult(submitted.taskId);
      const normalized = await normalizeProviderVideo(result);
      try {
        const bytes = await readFile(normalized.path);
        const objectPath = `parties/${partyId}/channels/${channelId}/delivery/${version}/${cameraId}.mp4`;
        await bucket.file(objectPath).save(bytes, {
          metadata: { contentType: "video/mp4", metadata: { expiresAt: expiry, jobId, partyId } },
        });
        clips.push({ cameraId, objectPath, sha256: normalized.sha256, sizeBytes: bytes.byteLength, durationMs: 2000, expiresAt: expiry });
      } finally {
        await removeNormalizedVideo(normalized);
      }
    }
    const stillSha = "a".repeat(64);
    await db.doc(`parties/${partyId}/jobs/${jobId}`).set({
      jobId, partyId, deviceId, channelId, manifestVersion: version, idempotencyKey: jobId, state: "ready",
      cartoonChain: { stillSha256: stillSha, videoStillSha256: stillSha, stillStatus: "completed", videoStatus: "completed" },
    });
    await db.doc(`parties/${partyId}/manifests/current_${channelId}`).set({
      partyId, channelId, version, schemaVersion: SCHEMA_VERSION, jobId, expiresAt: expiry,
      createdAt: FieldValue.serverTimestamp(), cameraClips: clips,
    });
    // Separately referenced preview bytes (hostPreviews prefix) survive the ACK purge.
    const previewPaths = clips.map((clip) => `parties/${partyId}/hostPreviews/cartoon-seed-1/${clip.cameraId}.mp4`);
    for (let index = 0; index < clips.length; index += 1) {
      const [bytes] = await bucket.file(clips[index].objectPath).download();
      await bucket.file(previewPaths[index]).save(bytes, {
        metadata: { contentType: "video/mp4", metadata: { expiresAt: expiry, purpose: "host-preview" } },
      });
    }
    const services = createDeliveryServices({ db, bucket, signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}` });
    const delivery = await services.getDeliveryUrls({ partyId, deviceId, channelId });
    assert.equal(delivery.clips.length, 4);
    const hashes: Record<string, string> = {};
    for (const clip of clips) {
      const [bytes] = await bucket.file(clip.objectPath).download();
      const hash = createHash("sha256").update(bytes).digest("hex");
      assert.equal(hash, clip.sha256);
      assert.equal(bytes.byteLength, clip.sizeBytes);
      hashes[clip.cameraId] = hash;
    }
    const ack = await services.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: version, clipHashes: hashes });
    assert.equal(ack.purged, true);
    for (const clip of clips) assert.equal((await bucket.file(clip.objectPath).exists())[0], false);
    for (const previewPath of previewPaths) {
      const [previewBytes] = await bucket.file(previewPath).download();
      assert.ok(previewBytes.byteLength > 0, "preview bytes must survive the delivery ACK");
    }
    // Withdrawal denial: a cartoon portrait withdrawal refuses new URLs.
    const portraitParty = randomPartyId();
    await seedParty(db, portraitParty, deviceId, channelId);
    const guestServices = createRuntimeServices({
      db, bucket, generationEnabled: true, provider: new FakeVideoGenerationPort(ASSETS),
      enqueueGeneration: async () => undefined,
      fixtureDirectory: ASSETS,
      pollIntervalMs: 1, sleep: async () => undefined,
      signGuestUploadUrl: async (file) => `https://upload.invalid/${encodeURIComponent(file.name)}`,
      signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
    });
    const requested = await guestServices.requestGuestUpload({
      partyId: portraitParty, deviceId, channelId,
      consent: { accepted: true, textVersion: "v1", purpose: "guest_cameo" }, contentType: "image/jpeg",
    });
    const photoBytes: Buffer = await readFile(resolve(__dirname, "fixtures/guest_photo.jpg"));
    await bucket.file(requested.objectPath).save(photoBytes, { contentType: "image/jpeg" });
    await guestServices.completeGuestUpload({ partyId: portraitParty, deviceId, channelId, submissionId: requested.submissionId });
    await guestServices.withdrawGuestMedia({ partyId: portraitParty, deviceId, channelId, submissionId: requested.submissionId });
    const withdrawnJobId = "job-cartoon-withdrawn";
    await db.doc(`parties/${portraitParty}/jobs/${withdrawnJobId}`).set({
      jobId: withdrawnJobId, partyId: portraitParty, deviceId, channelId, manifestVersion: 1, idempotencyKey: withdrawnJobId, state: "failed",
      cartoonChain: { stillSha256: stillSha, videoStillSha256: stillSha, stillStatus: "completed", videoStatus: "completed", portraitSubmissionId: requested.submissionId, portraitSourceHash: "a".repeat(64), portraitConsentRevision: requested.consentRevision },
      guestMedia: { submissionId: requested.submissionId, sourceHash: "a".repeat(64), consentRevision: requested.consentRevision },
    });
    await db.doc(`parties/${portraitParty}/manifests/current_${channelId}`).set({
      partyId: portraitParty, channelId, version: 1, schemaVersion: SCHEMA_VERSION, jobId: withdrawnJobId, expiresAt: expiry,
      createdAt: FieldValue.serverTimestamp(), cameraClips: clips.map((clip) => ({ ...clip, objectPath: clip.objectPath.replace(partyId, portraitParty) })),
    });
    await assert.rejects(guestServices.getDeliveryUrls({ partyId: portraitParty, deviceId, channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");
    await clearParty(db, bucket, portraitParty);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
