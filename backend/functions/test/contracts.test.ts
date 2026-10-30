import assert from "node:assert/strict";
import test from "node:test";
import { BackendError, parseAck, parseJoinPartyInput, parseRequestGeneration, requireIdentity } from "../src/contracts";
import { buildCheapDemoRequest, validateCheapDemoControls, validateGuestImageReference } from "../src/video_generation_port";
import { createVideoGenerationProviderFromEnvironment, FakeVideoGenerationPort } from "../src/providers/fake";
import { AlibabaVideoGenerationPort } from "../src/providers/alibaba";
import { createDeliveryServices } from "../src/delivery";
import { createEmulatorContext, clearParty, HAS_FIRESTORE_EMULATOR, randomPartyId, seedParty, disposeEmulatorContext } from "./support/emulators";

function expectCode(work: () => unknown, code: string): void {
  assert.throws(work, (error: unknown) => error instanceof BackendError && error.errorCode === code);
}

test("payload contracts reject missing identity, unsupported models, and noncanonical ACKs", () => {
  expectCode(() => requireIdentity({}), "UNAUTHENTICATED");
  expectCode(() => parseRequestGeneration({
    partyId: "party", deviceId: "tv", channelId: "main", jobId: "job-1", idempotencyKey: "job-1", presetId: "cheap_demo", modelId: "other-model",
  }), "INVALID_ARGUMENT");
  expectCode(() => parseRequestGeneration({
    partyId: "party", deviceId: "tv", channelId: "main", jobId: "job-1", idempotencyKey: "job-1", presetId: "premium",
  }), "INVALID_ARGUMENT");
  expectCode(() => parseAck({
    partyId: "party", deviceId: "tv", channelId: "main", manifestVersion: 1, clipHashes: { "CAM-01": "0".repeat(64) },
  }), "MANIFEST_MISMATCH");
  const parsed = parseRequestGeneration({
    partyId: "party", deviceId: "tv", channelId: "main", jobId: "job-1", idempotencyKey: "job-1", presetId: "cheap_demo",
  });
  assert.equal(parsed.presetId, "cheap_demo");
});

test("joinParty parser enforces identity, channel, and six-digit PIN shape", () => {
  expectCode(() => parseJoinPartyInput({}), "UNAUTHENTICATED");
  expectCode(() => parseJoinPartyInput({ partyId: "party", channelId: "main" }), "UNAUTHENTICATED");
  expectCode(() => parseJoinPartyInput({ deviceId: "p-x", channelId: "main" }), "UNAUTHENTICATED");
  expectCode(() => parseJoinPartyInput({ partyId: "party", deviceId: "p-x" }), "INVALID_ARGUMENT");
  expectCode(() => parseJoinPartyInput({ partyId: "party", deviceId: "p-x", channelId: "" }), "INVALID_ARGUMENT");
  expectCode(() => parseJoinPartyInput({ partyId: "bad id!", deviceId: "p-x", channelId: "main" }), "INVALID_ARGUMENT");
  for (const joinPin of ["123", "1234567", "abcdef", "12 456", "", 4201, null, "１２３４５６"]) {
    expectCode(() => parseJoinPartyInput({ partyId: "party", deviceId: "p-x", channelId: "main", joinPin }), "INVALID_ARGUMENT");
  }
  const noPin = parseJoinPartyInput({ partyId: "party", deviceId: "p-x", channelId: "main" });
  assert.ok(!("joinPin" in noPin));
  const leadingZeros = parseJoinPartyInput({ partyId: "party", deviceId: "p-x", channelId: "main", joinPin: "004201" });
  assert.equal(leadingZeros.joinPin, "004201");
});

test("registered callable enforces one in-flight job, idempotency, sanitized errors and zero retries", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const deviceId = "tv-living-room";
  const channelId = "main";
  let enqueued = 0;
  try {
    await seedParty(db, partyId, deviceId, channelId);
    const services = createDeliveryServices({ db, bucket, enqueueGeneration: async () => { enqueued += 1; } });
    const input = { partyId, deviceId, channelId, jobId: "job-1", idempotencyKey: "job-1", presetId: "cheap_demo" };
    const created = await services.requestGeneration(input);
    assert.equal(created.state, "queued");
    assert.equal(created.created, true);
    const duplicate = await services.requestGeneration(input);
    assert.equal(duplicate.created, false);
    assert.equal(enqueued, 1);

    await assert.rejects(
      services.requestGeneration({ ...input, jobId: "job-2", idempotencyKey: "job-2" }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "BUDGET_EXCEEDED",
    );
    await assert.rejects(services.runGeneration({ partyId, deviceId, channelId, jobId: "job-1", idempotencyKey: "job-1" }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "PROVIDER_UNAVAILABLE");
    const job = (await db.doc(`parties/${partyId}/jobs/job-1`).get()).data();
    const cost = (await db.doc(`parties/${partyId}/costLogs/job-1`).get()).data();
    assert.equal(job?.state, "failed");
    assert.equal(job?.errorCode, "PROVIDER_UNAVAILABLE");
    assert.equal(job?.modelId, "wan3.0-video");
    assert.equal(cost?.credits_charged, 0);
    assert.equal(cost?.success, false);
    assert.equal(cost?.partyId, partyId);
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("guest-bound generation contracts keep cheap_demo locked with a validated image reference", () => {
  const reference = {
    objectPath: "parties/pilot/guests/p-1/ingest/gsub-1/photo.jpg",
    sha256: "a".repeat(64),
    consentRevision: "v1:2026-10-30T00:00:00.000Z",
  };
  const parsed = parseRequestGeneration({
    partyId: "party", deviceId: "tv", channelId: "main", jobId: "job-1",
    idempotencyKey: "job-1", presetId: "cheap_demo", guestMediaId: "gsub-1",
  });
  assert.equal(parsed.guestMediaId, "gsub-1");
  expectCode(() => parseRequestGeneration({
    partyId: "party", deviceId: "tv", channelId: "main", jobId: "job-1",
    idempotencyKey: "job-1", presetId: "cheap_demo", guestMediaId: "",
  }), "INVALID_ARGUMENT");
  const request = buildCheapDemoRequest("job-1", "idem-1", "CAM-01", reference);
  assert.equal(request.modelId, "wan3.0-video");
  assert.equal(request.resolution, "480P");
  assert.equal(request.secondsOut, 2);
  assert.equal(request.audio, false);
  assert.equal(request.outputs, 1);
  assert.deepEqual(request.referenceImage, reference);
  const textOnly = buildCheapDemoRequest("job-1", "idem-1", "CAM-01");
  assert.equal(textOnly.referenceImage, undefined);
  expectCode(() => validateCheapDemoControls({ presetId: "cheap_demo", resolution: "720P" }), "INVALID_ARGUMENT");
  expectCode(() => validateGuestImageReference({ ...reference, objectPath: "parties/other/photo.jpg" }), "INVALID_ARGUMENT");
  expectCode(() => validateGuestImageReference({ ...reference, sha256: "zzz" }), "INVALID_ARGUMENT");
  expectCode(() => validateGuestImageReference({ ...reference, consentRevision: "" }), "INVALID_ARGUMENT");
});

test("a supplied fixture directory never silently forces fake mode over alibaba", () => {
  const previous = process.env.VIDEO_GENERATION_PROVIDER;
  try {
    process.env.VIDEO_GENERATION_PROVIDER = "alibaba";
    process.env.ALIBABA_API_KEY = "fixture-key";
    process.env.ALIBABA_WORKSPACE_ID = "workspace";
    const alibaba = createVideoGenerationProviderFromEnvironment("/packaged/runtime/fixtures");
    assert.ok(alibaba instanceof AlibabaVideoGenerationPort);
    process.env.VIDEO_GENERATION_PROVIDER = "fake";
    const fake = createVideoGenerationProviderFromEnvironment("/packaged/runtime/fixtures");
    assert.ok(fake instanceof FakeVideoGenerationPort);
  } finally {
    if (previous === undefined) delete process.env.VIDEO_GENERATION_PROVIDER;
    else process.env.VIDEO_GENERATION_PROVIDER = previous;
    delete process.env.ALIBABA_API_KEY;
    delete process.env.ALIBABA_WORKSPACE_ID;
  }
});
