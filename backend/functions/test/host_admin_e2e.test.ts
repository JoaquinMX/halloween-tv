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

test("exported host callables are wired through the runtime composition", async () => {
  const handlers = await import("../src/index");
  for (const name of ["createHostInvite", "joinHost", "revokeHostDevice", "listHostVideos", "generateHostVideo", "getHostVideoPreview", "deleteHostVideo"]) {
    assert.ok((handlers as Record<string, unknown>)[name] !== undefined, `${name} must be an exported callable`);
  }
  const { createRuntimeServices: compose } = await import("../src/runtime");
  assert.equal(typeof compose, "function");
});

test("host admin end-to-end: invite, roles, fixture-backed generation, preview survival, deletion, denials", { skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const channelId = "main";
  try {
    await seedParty(db, partyId, "tv-1", channelId);
    await db.doc(`parties/${partyId}/devices/tv-1`).update({ role: "tv" });
    await seedParty(db, partyId, "p-guest-1", channelId);
    const services = servicesFor(db, bucket);

    // Only the registered TV mints the invite; the token hash is stored.
    const invite = await services.createHostInvite({ partyId, deviceId: "tv-1", channelId });
    assert.ok(invite.inviteToken.startsWith("hi-"));
    assert.match(invite.pairingCode, /^[0-9]{6}$/);
    // Phone redeems for a separate identity with the server-assigned host role.
    const joined = await services.joinHost({ partyId, deviceId: "p-admin-1", channelId, inviteToken: invite.inviteToken, pairingCode: invite.pairingCode });
    assert.equal(joined.role, "host");
    assert.equal((await db.doc(`parties/${partyId}/devices/p-admin-1`).get()).data()?.role, "host");
    assert.equal((await db.doc(`parties/${partyId}/devices/tv-1`).get()).data()?.role, "tv");

    // Seed catalog starts empty, then queues fixed-preset generation.
    assert.deepEqual((await services.listHostVideos({ partyId, deviceId: "p-admin-1", channelId })).videos, []);
    const generated = await services.generateHostVideo({ partyId, deviceId: "p-admin-1", channelId, seedId: "catalog-1", idempotencyKey: "idem-catalog-1" });
    assert.equal(generated.created, true);
    // Real runtime generation with the fixture-backed provider and emulator storage.
    const run = await services.runGeneration({ partyId, deviceId: "p-admin-1", channelId, jobId: generated.jobId, idempotencyKey: "idem-catalog-1" });
    assert.equal(run.state, "ready");
    const manifest = (await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get()).data()!;
    assert.equal(manifest.cameraClips.length, 4);
    const preview = await services.getHostVideoPreview({ partyId, deviceId: "p-admin-1", channelId, seedId: "catalog-1" });
    assert.equal(preview.clips.length, 4);

    // Delivery ACK purges delivery bytes; preview bytes survive.
    const clipHashes = Object.fromEntries(
      (manifest.cameraClips as Array<{ cameraId: string; sha256: string }>).map((clip) => [clip.cameraId, clip.sha256]),
    );
    await services.acknowledgeDelivery({ partyId, deviceId: "p-admin-1", channelId, manifestVersion: manifest.version, clipHashes });
    const seed = (await db.doc(`parties/${partyId}/seedVideos/catalog-1`).get()).data()!;
    for (const path of seed.previewPaths as string[]) {
      const [bytes] = await bucket.file(path).download();
      assert.ok(bytes.byteLength > 0, "preview bytes must survive the delivery ACK");
    }

    // Deletion outcomes: seeds + objects removed, manifest revoked, accounting kept.
    const deleted = await services.deleteHostVideo({ partyId, deviceId: "p-admin-1", channelId, seedIds: ["catalog-1"] });
    assert.deepEqual(deleted.deletedSeedIds, ["catalog-1"]);
    assert.equal(deleted.revokedManifest, true);
    assert.ok((await db.collection(`parties/${partyId}/costLogs`).get()).docs.length >= 4);
    assert.deepEqual((await services.listHostVideos({ partyId, deviceId: "p-admin-1", channelId })).videos[0].status, "deleted");

    // Guest and cross-party callers are denied on every admin operation.
    await assert.rejects(services.listHostVideos({ partyId, deviceId: "p-guest-1", channelId }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    await assert.rejects(services.generateHostVideo({ partyId, deviceId: "p-guest-1", channelId, seedId: "x", idempotencyKey: "x" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    const foreign = randomPartyId();
    await seedParty(db, foreign, "tv-9", channelId);
    await db.doc(`parties/${foreign}/devices/tv-9`).update({ role: "tv" });
    const foreignInvite = await services.createHostInvite({ partyId: foreign, deviceId: "tv-9", channelId });
    const foreignHost = await services.joinHost({ partyId: foreign, deviceId: "p-foreign", channelId, inviteToken: foreignInvite.inviteToken, pairingCode: foreignInvite.pairingCode });
    assert.equal(foreignHost.role, "host");
    await assert.rejects(services.deleteHostVideo({ partyId, deviceId: "p-foreign", channelId, seedIds: ["catalog-1"] }),
      (e: unknown) => e instanceof BackendError && (e.errorCode === "FORBIDDEN" || e.errorCode === "NOT_FOUND"));
    await db.recursiveDelete(db.doc(`parties/${foreign}`)).catch(() => undefined);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("listPartyDevices returns only active guests: tv/host deviceIds are never leaked", { skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const channelId = "main";
  try {
    await seedParty(db, partyId, "tv-1", channelId);
    await db.doc(`parties/${partyId}/devices/tv-1`).update({ role: "tv" });
    const services = servicesFor(db, bucket);
    const invite = await services.createHostInvite({ partyId, deviceId: "tv-1", channelId });
    await services.joinHost({ partyId, deviceId: "p-admin-1", channelId, inviteToken: invite.inviteToken, pairingCode: invite.pairingCode });
    await db.doc(`parties/${partyId}/devices/p-guest-live`).set({ partyId, deviceId: "p-guest-live", role: "guest", status: "active" });
    await db.doc(`parties/${partyId}/devices/p-guest-dead`).set({ partyId, deviceId: "p-guest-dead", role: "guest", status: "disabled" });
    // A revoked host stays excluded too.
    await services.revokeHostDevice({ partyId, deviceId: "tv-1", channelId, targetDeviceId: "p-admin-1" });

    const listing = await services.listPartyDevices({ partyId, deviceId: "tv-1", channelId });
    assert.deepEqual(listing.devices.map((entry) => entry.deviceId), ["p-guest-live"]);
    assert.ok(!listing.devices.some((entry) => entry.deviceId === "tv-1"), "tv deviceId must never be listed");
    assert.ok(!listing.devices.some((entry) => entry.deviceId === "p-admin-1"), "host deviceId must never be listed");
    assert.ok(!listing.devices.some((entry) => entry.deviceId === "p-guest-dead"), "inactive guests must be excluded");
    assert.ok(listing.devices.every((entry) => entry.role === "guest" && entry.status === "active"));
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("deletion racing the worker blocks publication through the real pipeline", { skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedParty(db, partyId, "tv-1", "main");
    await db.doc(`parties/${partyId}/devices/tv-1`).update({ role: "tv" });
    const services = servicesFor(db, bucket);
    const invite = await services.createHostInvite({ partyId, deviceId: "tv-1", channelId: "main" });
    await services.joinHost({ partyId, deviceId: "p-admin-1", channelId: "main", inviteToken: invite.inviteToken, pairingCode: invite.pairingCode });
    const generated = await services.generateHostVideo({ partyId, deviceId: "p-admin-1", channelId: "main", seedId: "race-1", idempotencyKey: "idem-race-1" });
    // Delete wins the race before the worker runs: the tombstone is durable.
    const deleted = await services.deleteHostVideo({ partyId, deviceId: "p-admin-1", channelId: "main", seedIds: ["race-1"] });
    assert.deepEqual(deleted.deletedSeedIds, ["race-1"]);
    await assert.rejects(
      services.runGeneration({ partyId, deviceId: "p-admin-1", channelId: "main", jobId: generated.jobId, idempotencyKey: "idem-race-1" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN",
    );
    assert.equal((await db.doc(`parties/${partyId}/manifests/current_main`).get()).exists, false);
    await assert.rejects(services.getHostVideoPreview({ partyId, deviceId: "p-admin-1", channelId: "main", seedId: "race-1" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "NOT_FOUND");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("host seed provenance authorizes delivery without fabricated mobile consent", async () => {
  const { evaluateDeliveryProvenance } = await import("../src/contracts");
  const job = { partyId: "p", channelId: "main", jobId: "hv-seed-9", seedProvenance: { seedId: "seed-9", kind: "host" } };
  const seed = { seedId: "seed-9", partyId: "p", channelId: "main", status: "ready", operatorApproved: true, expiresAt: "2030-01-01T00:00:00.000Z" };
  assert.equal(evaluateDeliveryProvenance({ job, seed, nowMs: Date.now() }), "host");
  const deleted = { ...seed, status: "deleted" };
  assert.throws(() => evaluateDeliveryProvenance({ job, seed: deleted, nowMs: Date.now() }),
    (e: unknown) => e instanceof BackendError && (e.errorCode === "NOT_FOUND" || e.errorCode === "FORBIDDEN"));
});
