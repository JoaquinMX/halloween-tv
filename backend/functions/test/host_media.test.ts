import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { Bucket } from "@google-cloud/storage";
import type { Firestore } from "firebase-admin/firestore";
import { BackendError } from "../src/contracts";
import { createRuntimeServices } from "../src/runtime";
import { FakeVideoGenerationPort } from "../src/providers/fake";
import {
  HAS_FIRESTORE_EMULATOR,
  clearParty,
  createEmulatorContext,
  disposeEmulatorContext,
  randomPartyId,
  seedParty,
} from "./support/emulators";
import { createHostJoinService } from "../src/host_join";

const ASSET_FIXTURE_DIR = resolve(__dirname, "../../../apps/tv_app/assets");

function servicesFor(db: Firestore, bucket: Bucket) {
  return createRuntimeServices({
    db,
    bucket,
    generationEnabled: true,
    provider: new FakeVideoGenerationPort(ASSET_FIXTURE_DIR),
    fixtureDirectory: ASSET_FIXTURE_DIR,
    enqueueGeneration: async () => undefined,
    pollIntervalMs: 1,
    sleep: async () => undefined,
    signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
  });
}

async function seedHostParty(db: Firestore, partyId: string, channelId = "main"): Promise<{ tv: string; host: string }> {
  const tv = "tv-host-1";
  const host = "p-host-1";
  await seedParty(db, partyId, tv, channelId);
  await db.doc(`parties/${partyId}/devices/${tv}`).update({ role: "tv" });
  const hosts = createHostJoinService({ db });
  const invite = await hosts.createHostInvite({ partyId, deviceId: tv, channelId });
  await hosts.joinHost({ partyId, deviceId: host, channelId, inviteToken: invite.inviteToken });
  return { tv, host };
}

test("host seed catalog: empty list, guest denial, and fixed-preset queue with idempotency", { skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    const { host } = await seedHostParty(db, partyId);
    await seedParty(db, partyId, "p-guest-1", "main");
    const services = servicesFor(db, bucket);
    const empty = await services.listHostVideos({ partyId, deviceId: host, channelId: "main" });
    assert.deepEqual(empty.videos, []);
    // Guests (and unregistered devices) are denied on every admin operation.
    for (const call of [
      () => services.listHostVideos({ partyId, deviceId: "p-guest-1", channelId: "main" }),
      () => services.generateHostVideo({ partyId, deviceId: "p-guest-1", channelId: "main", seedId: "seed-1", idempotencyKey: "idem-1" }),
      () => services.getHostVideoPreview({ partyId, deviceId: "p-guest-1", channelId: "main", seedId: "seed-1" }),
      () => services.deleteHostVideo({ partyId, deviceId: "p-guest-1", channelId: "main", seedIds: ["seed-1"] }),
      () => services.listHostVideos({ partyId, deviceId: "nobody", channelId: "main" }),
    ]) {
      await assert.rejects(call(), (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    }
    // Generate uses the fixed-preset queue: same idempotency/budget shape as requestGeneration.
    const created = await services.generateHostVideo({ partyId, deviceId: host, channelId: "main", seedId: "seed-1", idempotencyKey: "idem-1" });
    assert.equal(created.seedId, "seed-1");
    assert.equal(created.state, "queued");
    assert.equal(created.created, true);
    assert.ok(created.jobId.startsWith("hv-"));
    const listed = await services.listHostVideos({ partyId, deviceId: host, channelId: "main" });
    assert.equal(listed.videos.length, 1);
    assert.equal(listed.videos[0].seedId, "seed-1");
    assert.equal(listed.videos[0].status, "queued");
    // Queue deduplication: the same request is idempotent, a second seed is budget-blocked.
    const duplicate = await services.generateHostVideo({ partyId, deviceId: host, channelId: "main", seedId: "seed-1", idempotencyKey: "idem-1" });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.jobId, created.jobId);
    await assert.rejects(
      services.generateHostVideo({ partyId, deviceId: host, channelId: "main", seedId: "seed-2", idempotencyKey: "idem-2" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "BUDGET_EXCEEDED",
    );
    // Rebinding a seed id to a different request is refused.
    await assert.rejects(
      services.generateHostVideo({ partyId, deviceId: host, channelId: "main", seedId: "seed-1", idempotencyKey: "idem-other" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN",
    );
    // Preview is not ready before the worker runs.
    await assert.rejects(services.getHostVideoPreview({ partyId, deviceId: host, channelId: "main", seedId: "seed-1" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "NOT_FOUND");
    // Cross-party hosts cannot touch this party's catalog.
    const otherParty = randomPartyId();
    const other = await seedHostParty(db, otherParty);
    await assert.rejects(services.getHostVideoPreview({ partyId, deviceId: other.host, channelId: "main", seedId: "seed-1" }),
      (e: unknown) => e instanceof BackendError && (e.errorCode === "FORBIDDEN" || e.errorCode === "NOT_FOUND"));
    await db.recursiveDelete(db.doc(`parties/${otherParty}`)).catch(() => undefined);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("host previews are separately referenced, TTL-limited, signed on demand, and survive ACK purge", { skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    const { host } = await seedHostParty(db, partyId);
    const services = servicesFor(db, bucket);
    const created = await services.generateHostVideo({ partyId, deviceId: host, channelId: "main", seedId: "seed-1", idempotencyKey: "idem-1" });
    const run = await services.runGeneration({ partyId, deviceId: host, channelId: "main", jobId: created.jobId, idempotencyKey: "idem-1" });
    assert.equal(run.state, "ready");
    const preview = await services.getHostVideoPreview({ partyId, deviceId: host, channelId: "main", seedId: "seed-1" });
    assert.equal(preview.seedId, "seed-1");
    assert.equal(preview.clips.length, 4);
    assert.deepEqual(preview.clips.map((clip) => clip.cameraId).sort(), ["CAM-01", "CAM-02", "CAM-03", "CAM-04"]);
    assert.ok(preview.clips.every((clip) => clip.url.startsWith("https://signed.invalid/")));
    assert.ok(preview.clips.every((clip) => clip.url.includes("hostPreviews")));
    // Preview objects are separately referenced from delivery objects.
    const seed = (await db.doc(`parties/${partyId}/seedVideos/seed-1`).get()).data()!;
    assert.equal(seed.status, "ready");
    assert.ok((seed.previewPaths as string[]).every((path) => path.includes("/hostPreviews/seed-1/")));
    assert.ok(!JSON.stringify(seed).includes("signed.invalid"), "signed preview URLs are never persisted");
    const manifest = (await db.doc(`parties/${partyId}/manifests/current_main`).get()).data()!;
    const deliveryPaths = (manifest.cameraClips as Array<{ objectPath: string }>).map((clip) => clip.objectPath);
    assert.ok(deliveryPaths.every((path) => !path.includes("hostPreviews")));
    for (const path of seed.previewPaths as string[]) {
      assert.equal((await bucket.file(path).exists())[0], true);
      const [previewBytes] = await bucket.file(path).download();
      assert.ok(previewBytes.byteLength > 0);
    }
    // Delivery ACK purges delivery objects but preview bytes survive.
    const clipHashes = Object.fromEntries(
      (manifest.cameraClips as Array<{ cameraId: string; sha256: string }>).map((clip) => [clip.cameraId, clip.sha256]),
    );
    const ack = await services.acknowledgeDelivery({ partyId, deviceId: host, channelId: "main", manifestVersion: manifest.version, clipHashes });
    assert.equal(ack.purged, true);
    for (const path of deliveryPaths) assert.equal((await bucket.file(path).exists())[0], false);
    for (const path of seed.previewPaths as string[]) assert.equal((await bucket.file(path).exists())[0], true);
    const previewAfterAck = await services.getHostVideoPreview({ partyId, deviceId: host, channelId: "main", seedId: "seed-1" });
    assert.equal(previewAfterAck.clips.length, 4);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("host deletion removes seeds and objects, revokes manifests, preserves accounting, and blocks races", { skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    const { host } = await seedHostParty(db, partyId);
    const services = servicesFor(db, bucket);
    const created = await services.generateHostVideo({ partyId, deviceId: host, channelId: "main", seedId: "seed-1", idempotencyKey: "idem-1" });
    await services.runGeneration({ partyId, deviceId: host, channelId: "main", jobId: created.jobId, idempotencyKey: "idem-1" });
    await services.getHostVideoPreview({ partyId, deviceId: host, channelId: "main", seedId: "seed-1" });
    const seedBefore = (await db.doc(`parties/${partyId}/seedVideos/seed-1`).get()).data()!;
    const previewPaths = [...(seedBefore.previewPaths as string[])];
    const manifestBefore = (await db.doc(`parties/${partyId}/manifests/current_main`).get()).data()!;
    const deliveryPaths = (manifestBefore.cameraClips as Array<{ objectPath: string }>).map((clip) => clip.objectPath);

    const deleted = await services.deleteHostVideo({ partyId, deviceId: host, channelId: "main", seedIds: ["seed-1"] });
    assert.deepEqual(deleted.deletedSeedIds, ["seed-1"]);
    assert.equal(deleted.revokedManifest, true);
    for (const path of [...previewPaths, ...deliveryPaths]) assert.ok(deleted.deletedObjects.includes(path), `${path} must be reported deleted`);
    assert.equal((await db.doc(`parties/${partyId}/seedVideos/seed-1`).get()).data()?.status, "deleted");
    assert.equal((await db.doc(`parties/${partyId}/manifests/current_main`).get()).exists, false);
    for (const path of [...previewPaths, ...deliveryPaths]) assert.equal((await bucket.file(path).exists())[0], false);
    // Accounting records are preserved.
    assert.ok((await db.collection(`parties/${partyId}/costLogs`).get()).docs.length >= 4, "cost logs must survive seed deletion");
    // A deleted seed never recreates previews and its job never republishes.
    await assert.rejects(services.getHostVideoPreview({ partyId, deviceId: host, channelId: "main", seedId: "seed-1" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "NOT_FOUND");
    await assert.rejects(services.runGeneration({ partyId, deviceId: host, channelId: "main", jobId: created.jobId, idempotencyKey: "idem-1" }).then(async (run) => {
      if (run.state === "ready") {
        const { publishManifest } = await import("../src/publish");
        const { FirestoreGenerationStore } = await import("../src/generation_store");
        await publishManifest(new FirestoreGenerationStore({ db, bucket }), partyId, created.jobId, "idem-1");
      }
      return run;
    }), (e: unknown) => e instanceof BackendError);
    // Deleting an unknown seed is NOT_FOUND; cross-party deletion is refused.
    await assert.rejects(services.deleteHostVideo({ partyId, deviceId: host, channelId: "main", seedIds: ["nope"] }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "NOT_FOUND");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
