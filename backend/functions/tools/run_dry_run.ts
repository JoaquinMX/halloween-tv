/** Emulator-only fake-provider E2E. The emulator URL signer below is a test
 * substitute and can never be selected by the deployed Functions runtime. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createDeliveryServices } from "../src/delivery";
import { REQUIRED_CAMERA_IDS } from "../src/config";
import { createGenerationServices } from "../src/generation";
import { canonicalManifestHash, type DeliveryManifest } from "../src/contracts";
import { FakeVideoGenerationPort } from "../src/providers/fake";
import { reconcileUsage, usageLedgerId } from "../src/usage";
import { sweepExpiredMedia } from "../src/retention";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function fail(message: string): never { throw new Error(message); }

function emulatorHost(value: string): string {
  return value.startsWith("http://") || value.startsWith("https://") ? value : `http://${value}`;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--target=emulator")) fail("Fake E2E requires explicit --target=emulator.");
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.STORAGE_EMULATOR_HOST) {
    fail("Fake E2E requires both FIRESTORE_EMULATOR_HOST and STORAGE_EMULATOR_HOST; cloud targets are refused.");
  }
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "demo-halloween-tv";
  if (!projectId.startsWith("demo-")) fail("Fake E2E requires a demo Firebase project ID.");
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucketName) fail("Fake E2E requires explicit FIREBASE_STORAGE_BUCKET.");
  const fixtureDirectory = existsSync(resolve(process.cwd(), "runtime/fixtures/cam01.mp4"))
    ? resolve(process.cwd(), "runtime/fixtures")
    : resolve(process.cwd(), "../../apps/tv_app/assets");
  const outputBase = resolve(argument("output-dir") ?? "delivery-output");
  const partyId = `dryrun-${randomUUID().replace(/-/g, "")}`;
  const deviceId = "dry-run-device";
  const channelId = "haunted_surveillance";
  const jobId = `job-${randomUUID().replace(/-/g, "")}`;
  const idempotencyKey = jobId;
  const app = initializeApp({ projectId, storageBucket: bucketName }, `dry-run-${randomUUID()}`);
  const db = getFirestore(app);
  const bucket = getStorage(app).bucket(bucketName);
  let retainedDirectory: string | undefined;
  try {
    const party = db.doc(`parties/${partyId}`);
    await Promise.all([
      party.set({ status: "active", activeChannelId: channelId }),
      party.collection("devices").doc(deviceId).set({ partyId, deviceId, status: "active" }),
      party.collection("channels").doc(channelId).set({ partyId, channelId, status: "active" }),
    ]);
    const services = createGenerationServices({
      db,
      bucket,
      provider: new FakeVideoGenerationPort(fixtureDirectory),
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    const requestInput = { partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo" };
    const request = await services.requestGeneration(requestInput);
    assert.equal(request.created, true);
    assert.equal(request.manifestVersion, 1);
    const beforeIssues = await reconcileUsage(db);
    assert.deepEqual(beforeIssues, [], `usage reconciliation before delivery: ${JSON.stringify(beforeIssues)}`);
    for (const cameraId of REQUIRED_CAMERA_IDS) {
      const row: FirebaseFirestore.DocumentData | undefined = (await db.doc(`parties/${partyId}/costLogs/${usageLedgerId(jobId, cameraId)}`).get()).data();
      assert.ok(row, `missing initial cost row for ${cameraId}`);
      assert.equal(row.model_id, "wan3.0-video");
      assert.equal(row.preset_id, "cheap_demo");
      assert.equal(row.seconds_out, 2);
      assert.equal(row.seconds_in, 0);
      assert.equal(row.success, false);
      assert.equal(row.provider_task_id, null);
      assert.equal(row.credits_charged, null);
      assert.equal(row.partyId, partyId);
      assert.equal(row.deviceId, deviceId);
      assert.equal(row.channelId, channelId);
      assert.equal(row.idempotencyKey, idempotencyKey);
    }

    const generation = await services.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey });
    assert.equal(generation.state, "ready");
    const manifestSnapshot = await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get();
    const manifest = manifestSnapshot.data() as (Pick<DeliveryManifest, "partyId" | "channelId" | "version" | "cameraClips"> & FirebaseFirestore.DocumentData) | undefined;
    assert.ok(manifest, "generation did not publish the current manifest");
    assert.equal(manifest.cameraClips.length, REQUIRED_CAMERA_IDS.length);
    const jobBeforeDelivery = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data() as FirebaseFirestore.DocumentData | undefined;
    assert.ok(jobBeforeDelivery);
    const outputDirectory = resolve(outputBase, partyId, `version-${manifest.version}`);
    retainedDirectory = outputDirectory;
    await mkdir(outputDirectory, { recursive: true });
    const usageAfterGenerate: Record<string, unknown>[] = [];
    for (const cameraId of REQUIRED_CAMERA_IDS) {
      const taskId: unknown = jobBeforeDelivery?.providerTasks?.[cameraId]?.taskId;
      assert.equal(typeof taskId, "string", `missing provider task binding for ${cameraId}`);
      const row: FirebaseFirestore.DocumentData | undefined = (await db.doc(`parties/${partyId}/costLogs/${usageLedgerId(jobId, cameraId)}`).get()).data();
      assert.ok(row);
      assert.equal(row.provider_task_id, taskId, `task ID ledger mismatch for ${cameraId}`);
      assert.equal(row.success, true, `missing success outcome for ${cameraId}`);
      assert.equal(row.credits_charged, 0, `fake provider must record synthetic zero for ${cameraId}`);
      assert.equal(row.seconds_out, 2);
      assert.equal(row.seconds_in, 0);
      usageAfterGenerate.push(row);
    }
    const afterGenerateIssues = await reconcileUsage(db);
    assert.deepEqual(afterGenerateIssues, [], `usage reconciliation after generation: ${JSON.stringify(afterGenerateIssues)}`);

    const urls = createDeliveryServices({
      db,
      bucket,
      signReadUrl: async (file) => `${emulatorHost(process.env.STORAGE_EMULATOR_HOST!)}/v0/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(file.name)}?alt=media`,
    });
    const deliveryUrls = await urls.getDeliveryUrls({ partyId, deviceId, channelId });
    assert.equal(deliveryUrls.manifestVersion, manifest.version);
    assert.equal(deliveryUrls.manifestHash, canonicalManifestHash(manifest));
    assert.equal(deliveryUrls.clips.length, 4);
    const hashes: Record<string, string> = {};
    for (const entry of deliveryUrls.clips) {
      const response = await fetch(entry.url, { headers: { Authorization: "Bearer owner" } });
      assert.equal(response.ok, true, `emulator fixture download failed for ${entry.cameraId}: ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const hash = createHash("sha256").update(bytes).digest("hex");
      const canonical: { cameraId: string; sha256: string; sizeBytes: number } | undefined = manifest.cameraClips.find((clip: { cameraId: string }) => clip.cameraId === entry.cameraId);
      assert.ok(canonical);
      assert.equal(hash, canonical.sha256);
      assert.equal(bytes.byteLength, canonical.sizeBytes);
      assert.equal(entry.sha256, hash);
      hashes[entry.cameraId] = hash;
      await writeFile(resolve(outputDirectory, `${entry.cameraId}.mp4`), bytes, { mode: 0o600 });
    }
    assert.deepEqual(Object.keys(hashes).sort(), [...REQUIRED_CAMERA_IDS].sort());
    const firstAck = await urls.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: deliveryUrls.manifestVersion, clipHashes: hashes });
    const repeatedAck = await urls.acknowledgeDelivery({ partyId, deviceId, channelId, manifestVersion: deliveryUrls.manifestVersion, clipHashes: hashes });
    assert.equal(firstAck.purged, true);
    assert.equal(repeatedAck.ackId, firstAck.ackId);
    const ack = (await db.doc(`parties/${partyId}/deliveryAcks/${firstAck.ackId}`).get()).data();
    const purgedJob = (await db.doc(`parties/${partyId}/jobs/${jobId}`).get()).data();
    assert.equal(ack?.manifestVersion, manifest.version);
    assert.equal(ack?.deviceId, deviceId);
    assert.equal(purgedJob?.state, "purged");
    assert.equal(purgedJob?.deliveryAckId, firstAck.ackId);
    for (const clip of manifest.cameraClips) {
      assert.equal((await bucket.file(clip.objectPath).exists())[0], false, `delivery object remains after ACK: ${clip.objectPath}`);
      const retained = await readFile(resolve(outputDirectory, `${clip.cameraId}.mp4`));
      assert.equal(createHash("sha256").update(retained).digest("hex"), clip.sha256, `retained bytes changed for ${clip.cameraId}`);
    }
    const afterDeliveryIssues = await reconcileUsage(db);
    assert.deepEqual(afterDeliveryIssues, [], `usage reconciliation after delivery: ${JSON.stringify(afterDeliveryIssues)}`);
    for (const cameraId of REQUIRED_CAMERA_IDS) {
      const row: FirebaseFirestore.DocumentData | undefined = (await db.doc(`parties/${partyId}/costLogs/${usageLedgerId(jobId, cameraId)}`).get()).data();
      const taskId: unknown = (purgedJob as FirebaseFirestore.DocumentData | undefined)?.providerTasks?.[cameraId]?.taskId;
      assert.equal(row?.provider_task_id, taskId);
      assert.equal(row?.success, true);
      assert.equal(row?.credits_charged, 0);
    }
    // TTL and orphan verification through the production retention service.
    const probeRoot = `parties/${partyId}/generated/${jobId}`;
    const expiredJobPath = `${probeRoot}/ttl-expired-job.mp4`;
    const expiredObjectPath = `${probeRoot}/ttl-expired-object.mp4`;
    const orphanPath = `${probeRoot}/unreferenced-orphan.mp4`;
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    for (const path of [expiredJobPath, expiredObjectPath]) {
      await bucket.file(path).save(Buffer.from(`expired-probe-${path}`), {
        resumable: false,
        metadata: { contentType: "video/mp4", customTime: past.toISOString(), metadata: { expiresAt: past.toISOString(), purpose: "ttl-probe" } },
      });
    }
    await bucket.file(orphanPath).save(Buffer.from("orphan-probe"), {
      resumable: false,
      metadata: { contentType: "video/mp4" },
    });
    await db.doc(`parties/${partyId}/jobs/ttl-probe`).set({
      jobId: "ttl-probe",
      partyId,
      channelId,
      state: "ready",
      presetId: "ttl_probe",
      deliveryPaths: [expiredJobPath],
      generatedPaths: [],
      expiresAt: Timestamp.fromDate(past),
    });
    // Referenced by a live job so the object scan (not the job branch) must
    // delete it because its own lifecycle metadata has expired.
    await db.doc(`parties/${partyId}/jobs/ttl-live`).set({
      jobId: "ttl-live",
      partyId,
      channelId,
      state: "ready",
      presetId: "ttl_probe",
      deliveryPaths: [expiredObjectPath],
      generatedPaths: [],
      expiresAt: Timestamp.fromDate(future),
    });
    const sweep = await sweepExpiredMedia(db, bucket, new Date());
    const expiredJob = (await db.doc(`parties/${partyId}/jobs/ttl-probe`).get()).data();
    assert.equal(expiredJob?.state, "expired", "TTL sweep did not transition the expired job");
    assert.equal((await db.doc(`parties/${partyId}/jobs/ttl-live`).get()).data()?.state, "ready", "TTL sweep must not expire a live job");
    assert.equal((await bucket.file(expiredJobPath).exists())[0], false, "TTL sweep left the expired job object in storage");
    assert.equal((await bucket.file(expiredObjectPath).exists())[0], false, "TTL sweep left the lifecycle-expired object in storage");
    assert.equal((await bucket.file(orphanPath).exists())[0], false, "TTL sweep left the unreferenced orphan object in storage");
    assert.ok(sweep.deletedExpiredObjects >= 1, `expected at least one expired object deletion, saw ${sweep.deletedExpiredObjects}`);
    assert.ok(sweep.deletedOrphanObjects >= 1, `expected at least one orphan object deletion, saw ${sweep.deletedOrphanObjects}`);

    process.stdout.write(`${JSON.stringify({
      mode: "fake-emulator-e2e",
      target: "emulator-only",
      networkGenerationCalls: 0,
      billableCalls: 0,
      fakeCredits: "synthetic zero",
      request,
      generation,
      manifestVersion: manifest.version,
      manifestHash: canonicalManifestHash(manifest),
      cameraIds: REQUIRED_CAMERA_IDS,
      downloadedAndHashed: REQUIRED_CAMERA_IDS.length,
      storageUrlMode: "emulator REST with Bearer owner (test-only signing/TLS substitute)",
      ackId: firstAck.ackId,
      ackRepeatedIdempotently: true,
      jobStateAfterAck: purgedJob.state,
      deliveryObjectsAbsent: true,
      retainedFilesReadableAfterPurge: true,
      retainedDirectory: outputDirectory,
      usageRows: usageAfterGenerate.map((row) => ({ cameraId: row.cameraId, providerTaskId: row.provider_task_id, success: row.success, credits: "synthetic zero" })),
      reconcileIssueCountBeforeDelivery: beforeIssues.length,
      reconcileIssueCountAfterDelivery: afterDeliveryIssues.length,
      ttlOrphanSweep: {
        expiredJobState: expiredJob?.state,
        expiredJobObjectDeleted: true,
        lifecycleExpiredObjectDeleted: true,
        orphanObjectDeleted: true,
        ...sweep,
      },
    })}\n`);
  } finally {
    await db.recursiveDelete(db.doc(`parties/${partyId}`));
    const [files] = await bucket.getFiles({ prefix: `parties/${partyId}/` });
    await Promise.all(files.map((file) => file.delete({ ignoreNotFound: true })));
    await deleteApp(app);
    if (!retainedDirectory) process.stderr.write("Dry-run did not create retained delivery files.\n");
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
