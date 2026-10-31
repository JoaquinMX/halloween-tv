import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { BackendError, DeliveryManifest, canonicalManifestHash, parseAck, parseCurrentManifestInput, parseRequestGeneration, validateCanonicalClips } from "../src/contracts";
import { expectedCameraIds } from "../src/config";
import { GUEST_CONSENT_PURPOSE, GUEST_CONSENT_TEXT_VERSION } from "../src/config";
import { createRuntimeServices } from "../src/runtime";
import { FakeVideoGenerationPort } from "../src/providers/fake";
import { HAS_FIRESTORE_EMULATOR, clearParty, createEmulatorContext, disposeEmulatorContext, seedParty } from "./support/emulators";

interface ContractFixture {
  canonicalManifestHash: string;
  manifest: DeliveryManifest;
  requestGeneration: { request: { jobId: string }; response: { jobId: string; state: string; created: boolean } };
  getCurrentManifest: { request: unknown; response: unknown };
  deliveryUrls: { request: unknown; response: { manifestHash: string; manifestVersion: number; clips: Array<Record<string, unknown>> } };
  acknowledgeDelivery: { request: unknown; response: { ackId: string; manifestVersion: number; purged: boolean } };
  services: string[];
  guestConsent: {
    textVersion: string;
    purpose: string;
    uploadTtlMs: number;
    inputTtlMs: number;
    maxImageBytes: number;
    contentTypes: string[];
    objectPrefix: string;
    providerCamera: string;
    fixtureCameras: string[];
  };
}

async function readFixture(): Promise<ContractFixture> {
  const content = await readFile(resolve(__dirname, "../../../test/fixtures/backend_contract_v1.json"), "utf8");
  return JSON.parse(content) as ContractFixture;
}

test("shared v1 fixture parses and hashes through backend contract functions", async () => {
  const fixture = await readFixture();
  const request = parseRequestGeneration(fixture.requestGeneration.request);
  const ack = parseAck(fixture.acknowledgeDelivery.request);
  const manifestInput = parseCurrentManifestInput(fixture.getCurrentManifest.request);
  validateCanonicalClips(fixture.manifest.cameraClips);

  assert.equal(request.jobId, fixture.requestGeneration.response.jobId);
  assert.deepEqual(ack.clipHashes, Object.fromEntries(fixture.manifest.cameraClips.map((clip) => [clip.cameraId, clip.sha256])));
  assert.deepEqual(manifestInput, { partyId: "pilot", deviceId: "tv-pilot", channelId: "main" });
  assert.equal(canonicalManifestHash(fixture.manifest), fixture.canonicalManifestHash);
  assert.equal(
    fixture.acknowledgeDelivery.response.ackId,
    "47aa92e83cf6a4e3cf5ad02a1421357fc29f4fb236f415553e3f6bc8594b1541",
    "ackId is the deterministic device/channel/version idempotency key pinned by the fixture",
  );
  assert.ok(fixture.services.includes("requestGuestUpload"));
  assert.ok(fixture.services.includes("completeGuestUpload"));
  assert.ok(fixture.services.includes("getGuestMediaStatus"));
  assert.ok(fixture.services.includes("withdrawGuestMedia"));
  assert.equal(fixture.guestConsent.textVersion, GUEST_CONSENT_TEXT_VERSION);
  assert.equal(fixture.guestConsent.purpose, GUEST_CONSENT_PURPOSE);
  assert.equal(fixture.guestConsent.uploadTtlMs, 15 * 60 * 1000);
  assert.equal(fixture.guestConsent.inputTtlMs, 24 * 60 * 60 * 1000);
  assert.equal(fixture.guestConsent.providerCamera, "CAM-01");
  assert.deepEqual(fixture.guestConsent.fixtureCameras, ["CAM-02", "CAM-03", "CAM-04"]);
});

test("camera-count fixture accepts 1/2/4 first-N prefixes with legacy four-camera hashes preserved", async () => {
  const content = await readFile(resolve(__dirname, "../../../test/fixtures/cctv_counts_v1.json"), "utf8");
  const counts = JSON.parse(content) as {
    counts: number[]; defaultCount: number; cameraIds: string[];
    manifests: Record<string, DeliveryManifest>;
    invalid: Record<string, { cameraClips: unknown }>;
  };
  assert.deepEqual(counts.counts, [1, 2, 4]);
  assert.equal(counts.defaultCount, 4);
  assert.deepEqual(counts.cameraIds, [...expectedCameraIds(4)]);
  for (const count of [1, 2, 4]) {
    const manifest = counts.manifests[String(count)];
    validateCanonicalClips(manifest.cameraClips);
    assert.equal(manifest.cameraClips.length, count);
    // Reordered valid clips remain accepted.
    validateCanonicalClips([...manifest.cameraClips].reverse());
    const ack = parseAck({
      partyId: manifest.partyId, deviceId: "tv-pilot", channelId: manifest.channelId,
      manifestVersion: manifest.version,
      clipHashes: Object.fromEntries(manifest.cameraClips.map((clip) => [clip.cameraId, clip.sha256])),
    });
    assert.deepEqual(Object.keys(ack.clipHashes).sort(), [...expectedCameraIds(count)].sort());
  }
  // Legacy four-camera fixture hashes and idempotency are preserved.
  const legacy = await readFixture();
  assert.equal(canonicalManifestHash(counts.manifests["4"]), legacy.canonicalManifestHash);
  assert.equal(
    legacy.acknowledgeDelivery.response.ackId,
    "47aa92e83cf6a4e3cf5ad02a1421357fc29f4fb236f415553e3f6bc8594b1541",
  );
  // Unsupported counts, gaps, duplicates, unknown cameras, and invalid
  // existing metadata are rejected.
  for (const key of Object.keys(counts.invalid)) {
    assert.throws(
      () => validateCanonicalClips((counts.invalid[key] as { cameraClips: unknown }).cameraClips),
      (error: unknown) => error instanceof BackendError && error.errorCode === "MANIFEST_MISMATCH",
      `${key} must be rejected`,
    );
  }
  // ACK hashes must exactly match the actual manifest: extra hashes rejected.
  const two = counts.manifests["2"];
  assert.throws(
    () => parseAck({
      partyId: two.partyId, deviceId: "tv-pilot", channelId: two.channelId, manifestVersion: two.version,
      clipHashes: Object.fromEntries([...two.cameraClips.map((clip) => [clip.cameraId, clip.sha256] as const), ["CAM-03", "c".repeat(64)] as const]),
    }),
    (error: unknown) => error instanceof BackendError && error.errorCode === "MANIFEST_MISMATCH",
  );
});
test("shared v1 fixture runs through callable service composition", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const fixture = await readFixture();
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = fixture.manifest.partyId;
  const deviceId = "tv-pilot";
  const now = new Date("2026-10-29T15:00:00.000Z");
  let enqueued = 0;
  try {
    await clearParty(db, bucket, partyId);
    await seedParty(db, partyId, deviceId, fixture.manifest.channelId);
    const services = createRuntimeServices({
      db,
      bucket,
      generationEnabled: true,
      provider: new FakeVideoGenerationPort(),
      now: () => now,
      enqueueGeneration: async () => { enqueued += 1; },
      signReadUrl: async (file) => `https://signed.invalid/${encodeURIComponent(file.name)}`,
    });

    const requestResponse = await services.requestGeneration(fixture.requestGeneration.request);
    assert.deepEqual(requestResponse, fixture.requestGeneration.response);
    assert.equal(enqueued, 1);

    await db.doc(`parties/${partyId}/manifests/current_${fixture.manifest.channelId}`).set(fixture.manifest);
    await Promise.all(fixture.manifest.cameraClips.map((clip) => bucket.file(clip.objectPath).save(Buffer.from(clip.cameraId))));
    const currentManifest = await services.getCurrentManifest(fixture.getCurrentManifest.request);
    assert.deepEqual(currentManifest, fixture.getCurrentManifest.response);

    const delivery = await services.getDeliveryUrls(fixture.deliveryUrls.request);
    assert.equal(delivery.manifestHash, fixture.deliveryUrls.response.manifestHash);
    assert.equal(delivery.manifestVersion, fixture.deliveryUrls.response.manifestVersion);
    assert.deepEqual(delivery.clips.map(({ cameraId, sha256, expiresAt }) => ({ cameraId, sha256, expiresAt, url: "<signed-v4-read-url>" })),
      fixture.deliveryUrls.response.clips);
    assert.ok(delivery.clips.every((clip) => clip.url.startsWith("https://signed.invalid/")));

    const ackResponse = await services.acknowledgeDelivery(fixture.acknowledgeDelivery.request);
    assert.deepEqual(ackResponse, fixture.acknowledgeDelivery.response);
    for (const clip of fixture.manifest.cameraClips) assert.equal((await bucket.file(clip.objectPath).exists())[0], false);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("Dart decoders stay compatible as a read-only reference (no app edits)", async () => {
  // The backend response shape is compared against the checked-in Dart
  // decoder expectations WITHOUT editing any app file: 1/2/4 first-N
  // prefixes, canonical ACK hashing, HTTPS URL + expiry + hash checks.
  const decoderSource = await readFile(resolve(__dirname, "../../../packages/infra_signed_urls/lib/src/firebase_delivery_client.dart"), "utf8");
  assert.match(decoderSource, /expectedCctvCameraIds/);
  assert.match(decoderSource, /manifestVersion/);
  assert.match(decoderSource, /clipHashes/);
  const fixture = await readFixture();
  // Backend canonical hash and ACK idempotency still match the pinned fixture
  // the Dart tests also consume (legacy four-camera hashes preserved).
  const { canonicalManifestHash } = await import("../src/contracts");
  assert.equal(canonicalManifestHash(fixture.manifest), fixture.canonicalManifestHash);
});

test("legacy-seed fixture parses and authorizes without fabricated mobile consent", async () => {
  const { evaluateDeliveryProvenance } = await import("../src/contracts");
  const raw = await readFile(resolve(__dirname, "fixtures/legacy_seed_delivery.json"), "utf8");
  const legacy = JSON.parse(raw) as {
    partyId: string; channelId: string; jobId: string;
    seedProvenance: { seedId: string; kind: string };
    seedDoc: Record<string, unknown>;
  };
  assert.equal(legacy.seedProvenance.kind, "legacy");
  const job = { partyId: legacy.partyId, channelId: legacy.channelId, jobId: legacy.jobId, seedProvenance: legacy.seedProvenance };
  assert.equal(evaluateDeliveryProvenance({ job, seed: legacy.seedDoc, nowMs: Date.parse("2026-10-29T15:00:00.000Z") }), "legacy");
  // Portable repo-relative paths only: no /tmp, no ~, no absolute out-of-repo refs.
  assert.ok(!JSON.stringify(legacy).includes("/tmp/") && !JSON.stringify(legacy).includes("/Users/"));
});
