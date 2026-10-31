import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { BackendError } from "../src/contracts";
import { buildAlibabaImageSubmitBody, cartoonStillSeed } from "../src/providers/alibaba_image";
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
import { getScenario, loadValidatedCatalogs, readScenarioReferenceBytes, resolveFunctionsRoot } from "../src/scenario_catalog";

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

test("cartoon still serializes to the verified sync multimodal body (no network)", () => {
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
  // Verified shape: single POST, messages content [style image, subject
  // image, text], in-process data URIs, size/seed/flags parameters.
  const body = buildAlibabaImageSubmitBody(request);
  assert.equal(body.model, "qwen-image-3.0-pro");
  const messages = (body.input as { messages: Array<{ role: string; content: Array<Record<string, string>> }> }).messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content.length, 3);
  const [styleItem, subjectItem, textItem] = messages[0].content;
  assert.match(String(styleItem.image), /^data:image\/jpeg;base64,/);
  assert.match(String(subjectItem.image), /^data:image\/jpeg;base64,/);
  // Role ordering preserved: style_scene bytes first, subject_identity second.
  assert.deepEqual(Buffer.from(String(styleItem.image).split(",")[1], "base64"), Buffer.from(readScenarioReferenceBytes(
    getScenario(catalog, "attic-computer-corner"), FUNCTIONS_ROOT)));
  assert.deepEqual(Buffer.from(String(subjectItem.image).split(",")[1], "base64"), Buffer.from(PORTRAIT_BYTES));
  assert.equal(textItem.text, request.prompt);
  // Fix-5b: the composed still maps wire positions explicitly.
  assert.ok(request.prompt.includes("reference image 1 is the SCENE/STYLE reference only"));
  assert.ok(request.prompt.includes("reference image 2 is the ACTUAL PERSON"));
  assert.deepEqual(body.parameters, {
    size: "1024*768",
    n: 1,
    seed: cartoonStillSeed(request.idempotencyKey),
    prompt_extend: false,
    enable_thinking: false,
    watermark: false,
    negative_prompt: request.negativePrompt,
  });
  // Digests stay on the request path: no sha or private path leaks on the wire.
  assert.ok(!JSON.stringify(body).includes(PORTRAIT_SHA.slice(0, 16)));
  assert.ok(!JSON.stringify(body).includes("parties/"));
  // Tampered bytes fail closed before transport.
  const tampered = new Uint8Array(PORTRAIT_BYTES);
  tampered[0] ^= 0xff;
  assert.throws(() => buildAlibabaImageSubmitBody({
    ...request,
    references: [{ ...request.references[0], bytes: tampered }, request.references[1]],
  }), /digest mismatch/);
});

test("cartoon video serializes STANDARD cheap_demo from the exact still as first_frame media (no network)", () => {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  const motion = buildCartoonMotionPrompt({
    scenarioId: "attic-computer-corner", situationId: "cramped-stumble-chase", catalog, situations,
  });
  // Canonical tiny still bytes shared with the pinned fixture (derived, never
  // mirrored from a wrong body): the video stage carries the exact still as an
  // in-process data URI, never hosted bytes.
  const stillPng = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082", "hex");
  const stillSha = createHash("sha256").update(stillPng).digest("hex");
  const stillDataUri = `data:image/png;base64,${stillPng.toString("base64")}`;
  const request = buildCartoonVideoRequest("job-cartoon-1", "idem-cartoon-1", "CAM-01", motion, {
    url: stillDataUri, sha256: stillSha,
  });
  assert.equal(request.modelId, "wan3.0-video");
  assert.equal(request.resolution, "480P");
  assert.equal(request.secondsOut, 2);
  assert.equal(request.audio, false);
  const body = buildAlibabaCartoonVideoBody(request);
  assert.equal(body.model, "wan3.0-video");
  // Verified shape: prompt verbatim (no appended suffix), still as
  // input.media first_frame data URI (no input.first_frame field).
  assert.equal((body.input as Record<string, unknown>).prompt, motion);
  assert.ok(!(("first_frame") in (body.input as Record<string, unknown>)));
  assert.deepEqual((body.input as Record<string, unknown>).media, [{ type: "first_frame", url: stillDataUri }]);
  assert.deepEqual(body.parameters, {
    resolution: "480P", ratio: "16:9", duration: 2, audio: false, watermark: false, prompt_extend: false, video_control: "STANDARD",
  });
  // The still hash binds the chain on the request path, never on the wire.
  assert.ok(!JSON.stringify(body).includes(stillSha));
  assert.throws(() => buildAlibabaCartoonVideoBody({ ...request, firstFrame: undefined } as never));
  // Hosted/signed bytes are refused on the live video wire: data URIs only.
  assert.throws(() => buildAlibabaCartoonVideoBody(buildCartoonVideoRequest("job-cartoon-1", "idem-cartoon-1", "CAM-01", motion, {
    url: "https://signed.invalid/cartoon-still.png", sha256: stillSha,
  })), /data URI/);
  assert.throws(() => buildCartoonVideoRequest("job-cartoon-1", "idem-cartoon-1", "CAM-02", motion, {
    url: stillDataUri, sha256: stillSha,
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
  // The rehearsal path carries the exact still as an in-process data URI
  // (production video-stage form); the offline fake accepts it without fetch.
  const stillDataUri = `data:image/png;base64,${Buffer.from(still.image).toString("base64")}`;
  const videoRequest = buildCartoonVideoRequest("job-cartoon-rehearsal", "idem-cartoon-rehearsal", "CAM-01", motion, {
    url: stillDataUri, sha256: still.sha256,
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

test("rollout-6 narrow classifier: only the pre-contact cartoon config error is definitive by identity", async () => {
  // Zero live calls: pure classifier unit test over the REAL prod classifier.
  const { CartoonImageProviderMissingError, isDefinitiveTerminalWorkerError } = await import("../src/generation");
  // The dedicated pre-contact configuration failure is definitive.
  assert.equal(isDefinitiveTerminalWorkerError(new CartoonImageProviderMissingError()), true);
  assert.equal(
    isDefinitiveTerminalWorkerError(new CartoonImageProviderMissingError("Cartoon image provider is not configured.")),
    true,
  );
  // Generic PROVIDER_UNAVAILABLE stays non-definitive (never broadened).
  assert.equal(isDefinitiveTerminalWorkerError(new BackendError("PROVIDER_UNAVAILABLE", "Cartoon image provider is not configured.")), false);
  assert.equal(isDefinitiveTerminalWorkerError(new BackendError("PROVIDER_UNAVAILABLE", "Provider task failed.")), false);
  assert.equal(
    isDefinitiveTerminalWorkerError(new BackendError("PROVIDER_UNAVAILABLE", "Cartoon still polling timed out; task ID is retained for reconciliation.")),
    false,
  );
  // Generic message matching stays excluded: same text as a plain Error or a
  // FAILED-detail BackendError must not become definitive.
  assert.equal(isDefinitiveTerminalWorkerError(new Error("Cartoon image provider is not configured.")), false);
  assert.equal(
    isDefinitiveTerminalWorkerError(new BackendError("PROVIDER_UNAVAILABLE", "Provider task failed (InvalidParameter: Field required).")),
    false,
  );
});
