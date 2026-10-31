import assert from "node:assert/strict";
import test from "node:test";
import { BackendError, HOST_MAX_DEVICES, HOST_SOURCE_CONSENT_PURPOSE, HOST_SOURCE_CONSENT_TEXT_VERSION, isHostSourceConsent, isSupportedConsent, parseAck, parseJoinPartyInput, parseRequestGeneration, requireIdentity, validateCanonicalClips, parseCreateHostInviteInput, parseJoinHostInput, parseDeleteHostVideoInput, parseGenerateHostVideoInput, parseRevokeHostDeviceInput } from "../src/contracts";
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
  // 1/2/4 first-N prefixes parse; anything else (gaps, unknown cameras,
  // unsupported counts, extra keys) is rejected.
  expectCode(() => parseAck({
    partyId: "party", deviceId: "tv", channelId: "main", manifestVersion: 1, clipHashes: { "CAM-01": "0".repeat(64), "CAM-02": "0".repeat(64), "CAM-03": "0".repeat(64) },
  }), "MANIFEST_MISMATCH");
  expectCode(() => parseAck({
    partyId: "party", deviceId: "tv", channelId: "main", manifestVersion: 1, clipHashes: { "CAM-01": "0".repeat(64), "CAM-03": "0".repeat(64) },
  }), "MANIFEST_MISMATCH");
  expectCode(() => parseAck({
    partyId: "party", deviceId: "tv", channelId: "main", manifestVersion: 1, clipHashes: { "CAM-05": "0".repeat(64) },
  }), "MANIFEST_MISMATCH");
  expectCode(() => parseAck({
    partyId: "party", deviceId: "tv", channelId: "main", manifestVersion: 1, clipHashes: { "CAM-01": "zzz" },
  }), "MANIFEST_MISMATCH");
  const ack1 = parseAck({
    partyId: "party", deviceId: "tv", channelId: "main", manifestVersion: 1, clipHashes: { "CAM-01": "0".repeat(64) },
  });
  assert.deepEqual(Object.keys(ack1.clipHashes), ["CAM-01"]);
  const ack2 = parseAck({
    partyId: "party", deviceId: "tv", channelId: "main", manifestVersion: 1, clipHashes: { "CAM-02": "1".repeat(64), "CAM-01": "0".repeat(64) },
  });
  assert.deepEqual(Object.keys(ack2.clipHashes).sort(), ["CAM-01", "CAM-02"]);
  const ack4 = parseAck({
    partyId: "party", deviceId: "tv", channelId: "main", manifestVersion: 1,
    clipHashes: { "CAM-01": "0".repeat(64), "CAM-02": "1".repeat(64), "CAM-03": "2".repeat(64), "CAM-04": "3".repeat(64) },
  });
  assert.deepEqual(Object.keys(ack4.clipHashes).sort(), ["CAM-01", "CAM-02", "CAM-03", "CAM-04"]);
  const parsed = parseRequestGeneration({
    partyId: "party", deviceId: "tv", channelId: "main", jobId: "job-1", idempotencyKey: "job-1", presetId: "cheap_demo",
  });
  assert.equal(parsed.presetId, "cheap_demo");
});

test("manifest validators accept 1/2/4 first-N prefixes and reject gaps, duplicates, and unknown cameras", () => {
  const clip = (cameraId: string, sha256 = "a".repeat(64)) => ({
    cameraId, objectPath: `parties/pilot/channels/main/delivery/1/${cameraId}.mp4`,
    sha256, sizeBytes: 12345, durationMs: 2000, expiresAt: "2026-11-29T15:00:00.000Z",
  });
  // Reordered valid clips remain accepted at every supported count.
  validateCanonicalClips([clip("CAM-02"), clip("CAM-01")]);
  validateCanonicalClips([clip("CAM-04"), clip("CAM-03"), clip("CAM-02"), clip("CAM-01")]);
  validateCanonicalClips([clip("CAM-01")]);
  for (const clips of [
    [clip("CAM-01"), clip("CAM-02"), clip("CAM-03")],
    [clip("CAM-01"), clip("CAM-03")],
    [clip("CAM-02")],
    [clip("CAM-01"), clip("CAM-01")],
    [clip("CAM-05")],
    [clip("CAM-01"), { ...clip("CAM-02"), sha256: "zzz" }],
  ]) {
    assert.throws(() => validateCanonicalClips(clips as never), (error: unknown) => error instanceof BackendError && error.errorCode === "MANIFEST_MISMATCH");
  }
  // Host invite parsers: guest PINs are never host tokens, roles are server-assigned.
  assert.deepEqual(parseCreateHostInviteInput({ partyId: "p", deviceId: "tv", channelId: "main" }), { partyId: "p", deviceId: "tv", channelId: "main" });
  assert.throws(() => parseJoinHostInput({ partyId: "p", deviceId: "x", channelId: "main", inviteToken: "004201", pairingCode: "000000" }), (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT");
  assert.throws(() => parseDeleteHostVideoInput({ partyId: "p", deviceId: "h", channelId: "main", seedIds: [] }), (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT");
});

test("host pairing code is required; wrong/missing codes deny generically (no oracle)", () => {
  const base = { partyId: "p", deviceId: "x", channelId: "main", inviteToken: "hi-abcdef" };
  // A correct-shaped pair parses through.
  assert.deepEqual(parseJoinHostInput({ ...base, pairingCode: "000000" }), { ...base, pairingCode: "000000" });
  // Missing or malformed codes deny with the SAME generic FORBIDDEN as an
  // unknown invite (never INVALID_ARGUMENT, which would be an oracle).
  for (const pairingCode of [undefined, "", "12345", "1234567", "abcdef", "12 456", 4201, null]) {
    assert.throws(() => parseJoinHostInput({ ...base, pairingCode }), (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN",
      `pairingCode ${String(pairingCode)} must deny generically`);
  }
});

test("host capacity and revocation parsers enforce their wire shapes", () => {
  assert.equal(HOST_MAX_DEVICES, 3);
  assert.deepEqual(
    parseRevokeHostDeviceInput({ partyId: "p", deviceId: "tv-1", channelId: "main", targetDeviceId: "p-host-1" }),
    { partyId: "p", deviceId: "tv-1", channelId: "main", targetDeviceId: "p-host-1" },
  );
  expectCode(() => parseRevokeHostDeviceInput({ partyId: "p", deviceId: "tv-1", channelId: "main" }), "INVALID_ARGUMENT");
  expectCode(() => parseRevokeHostDeviceInput({ partyId: "p", deviceId: "tv-1", channelId: "main", targetDeviceId: "bad id!" }), "INVALID_ARGUMENT");
});

test("host and guest consent namespaces stay distinct", () => {
  assert.equal(HOST_SOURCE_CONSENT_TEXT_VERSION, "host_source_v1");
  assert.equal(HOST_SOURCE_CONSENT_PURPOSE, "host_source");
  assert.ok(isSupportedConsent("v1", "guest_cameo"));
  assert.ok(isSupportedConsent(HOST_SOURCE_CONSENT_TEXT_VERSION, HOST_SOURCE_CONSENT_PURPOSE));
  assert.ok(!isSupportedConsent("v9", "guest_cameo"));
  assert.ok(!isSupportedConsent("v1", "host_source"));
  assert.ok(isHostSourceConsent(HOST_SOURCE_CONSENT_TEXT_VERSION, HOST_SOURCE_CONSENT_PURPOSE));
  assert.ok(!isHostSourceConsent("v1", "guest_cameo"));
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

test("cartoon catalog: 16 scenarios, pinned Alibaba Singapore models, fixed video controls", async () => {
  const { CARTOON_CATALOG_SCENARIOS, CARTOON_STILL_PRESET, CARTOON_VIDEO_PRESET, validateCartoonVideoControls } = await import("../src/contracts");
  assert.equal(CARTOON_CATALOG_SCENARIOS.length, 16);
  assert.deepEqual(CARTOON_CATALOG_SCENARIOS.map((s) => s.scenarioId), Array.from({ length: 16 }, (_, i) => `cartoon-${String(i + 1).padStart(2, "0")}`));
  for (const scenario of CARTOON_CATALOG_SCENARIOS) {
    assert.ok(scenario.stillPlanId && scenario.videoPlanId && scenario.version === 1 && Number.isSafeInteger(scenario.seed));
  }
  assert.equal(CARTOON_STILL_PRESET.modelId, "qwen-image-3.0-pro");
  assert.equal(CARTOON_STILL_PRESET.region, "singapore");
  assert.equal(CARTOON_VIDEO_PRESET.modelId, "wan3.0-video");
  assert.equal(CARTOON_VIDEO_PRESET.region, "singapore");
  assert.equal(CARTOON_VIDEO_PRESET.secondsOut, 2);
  assert.equal(CARTOON_VIDEO_PRESET.resolution, "480P");
  assert.equal(CARTOON_VIDEO_PRESET.audio, false);
  assert.equal(CARTOON_VIDEO_PRESET.videoControl, "STANDARD");
  validateCartoonVideoControls({ modelId: "wan3.0-video" });
  assert.throws(() => validateCartoonVideoControls({ modelId: "veo-3" }), (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT");
  assert.throws(() => validateCartoonVideoControls({ secondsOut: 5 }), (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT");
  assert.throws(() => validateCartoonVideoControls({ watermark: true }), (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT");
});

test("scoped provenance: approved legacy deliverable without mobile consent; explicit denials otherwise", async () => {
  const { evaluateDeliveryProvenance } = await import("../src/contracts");
  const baseJob = { partyId: "p", channelId: "main", jobId: "job-legacy", seedProvenance: { seedId: "seed-1", kind: "legacy" } };
  const approvedSeed = { seedId: "seed-1", partyId: "p", channelId: "main", status: "ready", operatorApproved: true, expiresAt: "2030-01-01T00:00:00.000Z" };
  assert.equal(evaluateDeliveryProvenance({ job: baseJob, seed: approvedSeed, nowMs: Date.parse("2026-10-29T15:00:00.000Z") }), "legacy");
  // Withdrawn / deleted / expired / unknown / unauthorized bindings fail explicitly.
  for (const [seed, code] of [
    [{ ...approvedSeed, status: "withdrawn" }, "FORBIDDEN"],
    [{ ...approvedSeed, status: "deleted" }, "NOT_FOUND"],
    [{ ...approvedSeed, status: "failed" }, "NOT_FOUND"],
    [{ ...approvedSeed, expiresAt: "2020-01-01T00:00:00.000Z" }, "CLIP_EXPIRED"],
    [{ ...approvedSeed, partyId: "other" }, "FORBIDDEN"],
    [{ ...approvedSeed, operatorApproved: false }, "FORBIDDEN"],
  ] as const) {
    assert.throws(() => evaluateDeliveryProvenance({ job: baseJob, seed, nowMs: Date.parse("2026-10-29T15:00:00.000Z") }),
      (e: unknown) => e instanceof BackendError && e.errorCode === code, JSON.stringify(seed));
  }
  assert.throws(() => evaluateDeliveryProvenance({ job: baseJob, seed: undefined, nowMs: Date.now() }),
    (e: unknown) => e instanceof BackendError && e.errorCode === "NOT_FOUND");
  // Unreadable authorization evidence fails closed, never fail-open.
  assert.throws(() => evaluateDeliveryProvenance({ job: baseJob, seed: approvedSeed, seedReadError: new Error("db down"), nowMs: Date.now() }),
    (e: unknown) => e instanceof BackendError && e.errorCode === "INTERNAL");
  const guestJob = { partyId: "p", channelId: "main", jobId: "job-guest", guestMedia: { submissionId: "gsub-1", sourceHash: "a".repeat(64), consentRevision: "v1:t" } };
  assert.throws(() => evaluateDeliveryProvenance({ job: guestJob, guest: undefined, guestReadError: new Error("db down"), nowMs: Date.now() }),
    (e: unknown) => e instanceof BackendError && e.errorCode === "INTERNAL");
  // Changed-source guest binding is refused explicitly.
  const eligibleGuest = { submissionId: "gsub-1", partyId: "p", channelId: "main", status: "eligible", consent: { accepted: true, textVersion: "v1", purpose: "guest_cameo" }, sourceHash: "b".repeat(64), consentRevision: "v1:t", expiresAt: "2030-01-01T00:00:00.000Z" };
  assert.throws(() => evaluateDeliveryProvenance({ job: guestJob, guest: eligibleGuest, nowMs: Date.now() }),
    (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
});

test("cartoon chain gate: incomplete or mismatched still-to-video stages are refused", async () => {
  const { assertCartoonChainComplete, evaluateDeliveryProvenance } = await import("../src/contracts");
  const still = "a".repeat(64);
  const complete = { stillSha256: still, videoStillSha256: still, stillStatus: "completed", videoStatus: "completed" };
  assertCartoonChainComplete({ cartoonChain: complete } as unknown as Record<string, unknown>);
  for (const chain of [
    undefined,
    { stillSha256: still, videoStillSha256: "b".repeat(64), stillStatus: "completed" },
    { stillSha256: still, videoStillSha256: still, stillStatus: "running" },
    { stillSha256: "zzz", videoStillSha256: "zzz", stillStatus: "completed" },
  ]) {
    assert.throws(() => assertCartoonChainComplete({ cartoonChain: chain } as unknown as Record<string, unknown>),
      (e: unknown) => e instanceof BackendError && e.errorCode === "MANIFEST_MISMATCH");
  }
  // Publication replay for a cartoon job without a completed chain refuses.
  assert.throws(() => evaluateDeliveryProvenance({
    job: { partyId: "p", channelId: "main", jobId: "job-cartoon", cartoonChain: { stillSha256: still, videoStillSha256: "b".repeat(64), stillStatus: "completed" } },
    nowMs: Date.now(),
  }), (e: unknown) => e instanceof BackendError && e.errorCode === "MANIFEST_MISMATCH");
});

test("fix-5d HIGH: generateHostVideo callable rejects caller-supplied rehearsalOnly", () => {
  const base = { partyId: "p", deviceId: "h", channelId: "main", seedId: "seed-1", idempotencyKey: "idem-1" };
  const parsed = parseGenerateHostVideoInput(base);
  assert.ok(!("rehearsalOnly" in parsed));
  for (const rehearsalOnly of [true, false, "true", 1]) {
    assert.throws(() => parseGenerateHostVideoInput({ ...base, rehearsalOnly }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT",
      `rehearsalOnly ${String(rehearsalOnly)} must be rejected`);
  }
});

test("fix-5d HIGH: fixture stills never publish without the server-derived rehearsal marker", async () => {
  const { assertCartoonChainComplete } = await import("../src/contracts");
  const still = "a".repeat(64);
  const fixtureChain = { stillSha256: still, videoStillSha256: still, stillStatus: "completed", videoStatus: "completed", stillFixture: true };
  assert.throws(() => assertCartoonChainComplete({ cartoonChain: fixtureChain } as unknown as Record<string, unknown>),
    (e: unknown) => e instanceof BackendError && e.errorCode === "MANIFEST_MISMATCH");
  assertCartoonChainComplete({ rehearsalOnly: true, cartoonChain: fixtureChain } as unknown as Record<string, unknown>);
  assert.throws(() => assertCartoonChainComplete({ rehearsalOnly: false, cartoonChain: fixtureChain } as unknown as Record<string, unknown>),
    (e: unknown) => e instanceof BackendError && e.errorCode === "MANIFEST_MISMATCH");
});
