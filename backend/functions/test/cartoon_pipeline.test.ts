import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { BackendError } from "../src/contracts";
import { buildAlibabaImageSubmitBody } from "../src/providers/alibaba_image";
import { buildAlibabaCartoonVideoBody } from "../src/providers/alibaba";
import { FakeImageGenerationPort } from "../src/providers/fake_image";
import { FakeVideoGenerationPort } from "../src/providers/fake";
import {
  buildCartoonMotionPrompt,
  buildCartoonStillRequest,
  cartoonStillIdempotencyKey,
  generateCartoonStill,
  sha256,
} from "../src/cartoon_pipeline";
import { buildCartoonVideoRequest, validateCartoonPlan } from "../src/video_generation_port";
import { loadValidatedCatalogs, resolveFunctionsRoot } from "../src/scenario_catalog";

const FUNCTIONS_ROOT = resolveFunctionsRoot(resolve(__dirname, "../src"));
const PORTRAIT_BYTES = new Uint8Array(readFileSync(resolve(__dirname, "fixtures/guest_photo.jpg")));
const PORTRAIT_SHA = createHash("sha256").update(PORTRAIT_BYTES).digest("hex");

test("cartoon still request is deterministic, role-ordered, and byte-verified (no network)", () => {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  const request = buildCartoonStillRequest({
    jobId: "job-cartoon-1",
    scenarioId: "attic-computer-corner",
    situationId: "cramped-stumble-chase",
    catalog,
    situations,
    portraitBytes: PORTRAIT_BYTES,
    portraitContentType: "image/jpeg",
    portraitSha256: PORTRAIT_SHA,
    functionsRoot: FUNCTIONS_ROOT,
  });
  assert.equal(request.modelId, "qwen-image-3.0-pro");
  assert.equal(request.region, "singapore");
  assert.equal(request.idempotencyKey, cartoonStillIdempotencyKey("job-cartoon-1", "attic-computer-corner", "cramped-stumble-chase"));
  assert.deepEqual(request.references.map((reference) => reference.role), ["subject_identity", "style_scene"]);
  assert.equal(request.references[0].sha256, PORTRAIT_SHA);
  // Deterministic: same inputs produce the same idempotency key and digests.
  const repeat = buildCartoonStillRequest({
    jobId: "job-cartoon-1",
    scenarioId: "attic-computer-corner",
    situationId: "cramped-stumble-chase",
    catalog,
    situations,
    portraitBytes: PORTRAIT_BYTES,
    portraitContentType: "image/jpeg",
    portraitSha256: PORTRAIT_SHA,
    functionsRoot: FUNCTIONS_ROOT,
  });
  assert.equal(repeat.idempotencyKey, request.idempotencyKey);
  // Byte verification: tampered bytes or digest mismatch fail closed.
  assert.throws(
    () => buildCartoonStillRequest({
      jobId: "job-cartoon-1", scenarioId: "attic-computer-corner", situationId: "cramped-stumble-chase",
      catalog, situations, portraitBytes: PORTRAIT_BYTES, portraitContentType: "image/jpeg",
      portraitSha256: "0".repeat(64), functionsRoot: FUNCTIONS_ROOT,
    }),
    (error: unknown) => error instanceof BackendError,
  );
});

test("offline fake still is idempotent with zero Alibaba calls", async () => {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  const request = buildCartoonStillRequest({
    jobId: "job-cartoon-1",
    scenarioId: "attic-computer-corner",
    situationId: "cramped-stumble-chase",
    catalog,
    situations,
    portraitBytes: PORTRAIT_BYTES,
    portraitContentType: "image/jpeg",
    portraitSha256: PORTRAIT_SHA,
    functionsRoot: FUNCTIONS_ROOT,
  });
  const fake = new FakeImageGenerationPort();
  const first = await generateCartoonStill(fake, request);
  const second = await generateCartoonStill(fake, request);
  assert.ok(first.image.length > 0);
  assert.equal(first.sha256, sha256(first.image));
  assert.equal(second.taskId, first.taskId, "idempotent reuse must not submit a duplicate still");
  assert.equal(fake.submissions.length, 1);
});

test("cartoon still serializes to the deterministic dual-ref wire mapping (no network)", () => {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  const request = buildCartoonStillRequest({
    jobId: "job-cartoon-1",
    scenarioId: "attic-computer-corner",
    situationId: "cramped-stumble-chase",
    catalog,
    situations,
    portraitBytes: PORTRAIT_BYTES,
    portraitContentType: "image/jpeg",
    portraitSha256: PORTRAIT_SHA,
    functionsRoot: FUNCTIONS_ROOT,
  });
  const body = buildAlibabaImageSubmitBody(request, [
    "https://signed.invalid/cartoon-portrait.jpg",
    "https://signed.invalid/cartoon-style.jpg",
  ]);
  assert.equal(body.model, "qwen-image-3.0-pro");
  assert.deepEqual((body.input as Record<string, unknown>).images, [
    "https://signed.invalid/cartoon-portrait.jpg",
    "https://signed.invalid/cartoon-style.jpg",
  ]);
  assert.match(String((body.input as Record<string, unknown>).prompt), /subject_identity.*style_scene/s);
  assert.equal((body.parameters as Record<string, unknown>).negative_prompt, request.negativePrompt);
  assert.ok(!JSON.stringify(body).includes(PORTRAIT_SHA.slice(0, 16)));
  // Unfetchable resolver output never reaches transport.
  assert.throws(() => buildAlibabaImageSubmitBody(request, ["http://signed.invalid/a.jpg", "https://signed.invalid/b.jpg"] as unknown as [string, string]));
});

test("cartoon video serializes STANDARD cheap_demo from the exact still as first_frame (no network)", () => {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  const motion = buildCartoonMotionPrompt({
    scenarioId: "attic-computer-corner", situationId: "cramped-stumble-chase", catalog, situations,
  });
  const stillSha = createHash("sha256").update("cartoon-fixture-still").digest("hex");
  const request = buildCartoonVideoRequest("job-cartoon-1", "idem-cartoon-1", "CAM-01", motion, {
    url: "https://signed.invalid/cartoon-still.png", sha256: stillSha,
  });
  assert.equal(request.modelId, "wan3.0-video");
  assert.equal(request.resolution, "480P");
  assert.equal(request.secondsOut, 2);
  assert.equal(request.audio, false);
  const body = buildAlibabaCartoonVideoBody(request);
  assert.equal(body.model, "wan3.0-video");
  assert.equal((body.input as Record<string, unknown>).first_frame, "https://signed.invalid/cartoon-still.png");
  assert.match(String((body.input as Record<string, unknown>).prompt), /Locked camera/);
  assert.deepEqual(body.parameters, {
    resolution: "480P", ratio: "16:9", duration: 2, audio: false, watermark: false, prompt_extend: false, video_control: "STANDARD",
  });
  // The still hash binds the chain on the request path, never on the wire.
  assert.ok(!JSON.stringify(body).includes(stillSha));
  assert.throws(() => buildAlibabaCartoonVideoBody({ ...request, firstFrame: undefined } as never));
  assert.throws(() => buildCartoonVideoRequest("job-cartoon-1", "idem-cartoon-1", "CAM-02", motion, {
    url: "https://signed.invalid/cartoon-still.png", sha256: stillSha,
  }), /CAM-01/);
  // Fixture parity: pinned video request serializes identically (no network).
  const fixture = JSON.parse(readFileSync(resolve(__dirname, "fixtures/alibaba_cartoon_video_request.json"), "utf8")) as {
    request: { prompt: string }; body: Record<string, unknown>;
  };
  assert.equal(fixture.request.prompt, motion);
  assert.deepEqual(fixture.body, body);
});

test("fake two-stage rehearsal animates the generated still with zero Alibaba calls", async () => {
  // Zero network: both stages resolve through the offline fakes. The video
  // stage animates the exact still bytes produced by the image stage.
  // Explicit fetch-count guard: any live-call regression inside the
  // rehearsal path fails here (fakes perform zero fetch calls; both ports
  // below are asserted to be the offline fakes and no fetch stub is used).
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  (globalThis as Record<string, unknown>).fetch = (async (...args: unknown[]) => {
    fetchCalls += 1;
    return (originalFetch as (...a: unknown[]) => Promise<unknown>)(...args);
  }) as typeof fetch;
  try {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  const request = buildCartoonStillRequest({
    jobId: "job-cartoon-rehearsal",
    scenarioId: "attic-computer-corner",
    situationId: "cramped-stumble-chase",
    catalog,
    situations,
    portraitBytes: PORTRAIT_BYTES,
    portraitContentType: "image/jpeg",
    portraitSha256: PORTRAIT_SHA,
    functionsRoot: FUNCTIONS_ROOT,
  });
  const imageFake = new FakeImageGenerationPort();
  const still = await generateCartoonStill(imageFake, request);
  const motion = buildCartoonMotionPrompt({
    scenarioId: "attic-computer-corner", situationId: "cramped-stumble-chase", catalog, situations,
  });
  const videoFake = new FakeVideoGenerationPort();
  const videoRequest = buildCartoonVideoRequest("job-cartoon-rehearsal", "idem-cartoon-rehearsal", "CAM-01", motion, {
    url: "https://signed.invalid/cartoon-still.png", sha256: still.sha256,
  });
  const submitted = await videoFake.submit(videoRequest);
  assert.ok(submitted.taskId.startsWith("CAM-01__"));
  assert.equal((await videoFake.getStatus(submitted.taskId)).state, "SUCCEEDED");
  const result = await videoFake.getResult(submitted.taskId);
  assert.equal(result.secondsOut, 2);
  assert.equal(result.creditsCharged, 0, "synthetic zero from the offline fake, never a measured charge");
  // Immutable plan shape survives the rehearsal.
  validateCartoonPlan({
    scenarioId: "attic-computer-corner", situationId: "cramped-stumble-chase",
    stillPlanId: "cartoon-still-plan-01", videoPlanId: "cartoon-video-plan-01", version: 1, seed: 130100,
  });
  assert.equal(fetchCalls, 0, "rehearsal must perform zero fetch calls");
  assert.ok(imageFake instanceof FakeImageGenerationPort);
  assert.ok(videoFake instanceof FakeVideoGenerationPort);
  // Pinned results fixture keeps unknown live credits truthful (null).
  const results = JSON.parse(readFileSync(resolve(__dirname, "fixtures/alibaba_cartoon_results.json"), "utf8")) as {
    still: { creditsCharged: null }; video: { creditsCharged: null };
  };
  assert.equal(results.still.creditsCharged, null);
  assert.equal(results.video.creditsCharged, null);
  } finally {
    (globalThis as Record<string, unknown>).fetch = originalFetch;
  }
});
