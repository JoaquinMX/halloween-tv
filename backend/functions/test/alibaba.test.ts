import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { AlibabaSubmissionError, AlibabaVideoGenerationPort, buildAlibabaSubmitBody } from "../src/providers/alibaba";
import { AlibabaImageGenerationPort, buildAlibabaImageSubmitBody, cartoonStillSeed } from "../src/providers/alibaba_image";
import type { CartoonStillRequest } from "../src/image_generation_port";
import { buildCameoDemoRequest, buildCheapDemoRequest } from "../src/video_generation_port";
import { CAMEO_DEMO_PRESET, CAMEO_DEMO_PROMPT } from "../src/config";

const fixture = JSON.parse(readFileSync(resolve("test/fixtures/alibaba_tasks.json"), "utf8")) as Record<string, unknown>;
const baseUrl = "https://workspace.ap-southeast-1.maas.aliyuncs.com";

test("Alibaba adapter submits the locked Singapore preset and polls one task", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new AlibabaVideoGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      const body = requests.length === 1 ? fixture.submit : requests.length === 2 ? fixture.pending : fixture.succeeded;
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  const request = buildCheapDemoRequest("job-1", "idem-1", "CAM-01");
  const submitted = await provider.submit(request);
  assert.equal(submitted.taskId, "task-fixture-001");
  const submitRequest = requests[0];
  assert.equal(submitRequest.url, `${baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`);
  const headers = new Headers(submitRequest.init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer fixture-key");
  assert.equal(headers.get("X-DashScope-Async"), "enable");
  const body = JSON.parse(String(submitRequest.init?.body)) as Record<string, unknown>;
  assert.equal(body.model, "wan3.0-video");
  assert.deepEqual(body.input, { prompt: request.prompt });
  assert.deepEqual(body.parameters, { resolution: "480P", ratio: "16:9", duration: 2, audio: false, watermark: false });

  assert.equal((await provider.getStatus(submitted.taskId)).state, "PENDING");
  assert.equal((await provider.getStatus(submitted.taskId)).state, "SUCCEEDED");
  const result = await provider.getResult(submitted.taskId);
  assert.deepEqual(result.video, { kind: "url", value: "https://fixture.invalid/result.mp4" });
  assert.equal(result.secondsOut, 2);
  assert.equal(result.creditsCharged, null);
  assert.equal(requests[3].url, `${baseUrl}/api/v1/tasks/task-fixture-001`);
});

test("Alibaba adapter refuses a substituted model or unsupported resolution before transport", async () => {
  let fetches = 0;
  const provider = new AlibabaVideoGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    fetchImpl: async () => { fetches += 1; return new Response("{}", { status: 200 }); },
  });
  const request = buildCheapDemoRequest("job-1", "idem-1", "CAM-01");
  await assert.rejects(provider.submit({ ...request, resolution: "720P" as "480P" }), /Unsupported resolution/);
  await assert.rejects(provider.submit({ ...request, modelId: "another-model" as "wan3.0-video" }), /Unsupported modelId/);
  assert.equal(fetches, 0);
});

test("Alibaba adapter refuses a text-only cameo request before transport", async () => {
  let fetches = 0;
  const provider = new AlibabaVideoGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    fetchImpl: async () => { fetches += 1; return new Response("{}", { status: 200 }); },
  });
  const reference = {
    objectPath: "parties/pilot/guests/p-guest001/ingest/gsub-guest001/photo.jpg",
    sha256: "9".repeat(64),
    consentRevision: "v1:2026-10-30T00:00:00.000Z",
  };
  const request = buildCameoDemoRequest("job-cameo-1", "idem-cameo-1", "CAM-01", reference);
  await assert.rejects(provider.submit({ ...request, referenceImage: undefined }), /reference image/);
  await assert.rejects(provider.submit({ ...request, modelId: "wan3.0-video" as "happyhorse-1.1-r2v" }), /Unsupported modelId/);
  await assert.rejects(provider.submit({ ...request, secondsOut: 2 as 5 }), /Unsupported secondsOut/);
  assert.equal(fetches, 0);
});

test("ambiguous Alibaba submission errors are explicitly non-retryable", async () => {
  const provider = new AlibabaVideoGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    fetchImpl: async () => { throw new Error("socket closed"); },
  });
  await assert.rejects(provider.submit(buildCheapDemoRequest("job-1", "idem-1", "CAM-01")), (error: unknown) =>
    error instanceof AlibabaSubmissionError && error.certainty === "unknown" && error.retryable === false);
});

test("definitive client rejection is marked non-billable for controlled retry policy", async () => {
  const provider = new AlibabaVideoGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    fetchImpl: async () => new Response(JSON.stringify({ code: "InvalidParameter" }), { status: 400 }),
  });
  await assert.rejects(provider.submit(buildCheapDemoRequest("job-1", "idem-1", "CAM-01")), (error: unknown) =>
    error instanceof AlibabaSubmissionError && error.certainty === "non_billable" && error.retryable === false);
});

test("Alibaba adapter refuses a provider endpoint outside Singapore", () => {
  assert.throws(() => new AlibabaVideoGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    baseUrl: "https://workspace.us-east-1.maas.aliyuncs.com",
    fetchImpl: fetch,
  }), /Singapore region/);
});

test("guest image reference serializes offline with cheap_demo limits unchanged", async () => {
  // Zero provider network requests: the pinned fixture is pure serialization.
  const fixture = JSON.parse(readFileSync(resolve("test/fixtures/alibaba_guest_request.json"), "utf8")) as {
    request: Record<string, unknown>;
    body: Record<string, unknown>;
  };
  const photoSha = createHash("sha256").update(readFileSync(resolve("test/fixtures/guest_photo.jpg"))).digest("hex");
  const request = buildCheapDemoRequest("job-guest-1", "idem-guest-1", "CAM-01", {
    objectPath: "parties/pilot/guests/p-guest001/ingest/gsub-guest001/photo.jpg",
    sha256: photoSha,
    consentRevision: "v1:2026-10-30T00:00:00.000Z",
    url: "https://signed.invalid/guest-photo.jpg",
  });
  assert.equal(request.modelId, "wan3.0-video");
  assert.equal(request.resolution, "480P");
  assert.equal(request.secondsOut, 2);
  assert.equal(request.audio, false);
  assert.equal(request.outputs, 1);
  assert.equal(request.autoUpscale, false);
  const body = buildAlibabaSubmitBody(request);
  assert.deepEqual(body, fixture.body);
  assert.equal((body.input as Record<string, unknown>).prompt, request.prompt);
  // Corrected r2v envelope: the signed URL rides as input.media; the sha256
  // stays on the request/ledger path and never enters the submitted JSON.
  assert.deepEqual((body.input as Record<string, unknown>).media, [{ type: "reference_image", url: "https://signed.invalid/guest-photo.jpg" }]);
  assert.ok(!("reference_image" in (body.input as Record<string, unknown>)));
  assert.ok(!JSON.stringify(body).includes(photoSha));
  // The private bucket path never leaves the backend: no storage_ref or
  // objectPath key survives serialization.
  assert.ok(!JSON.stringify(body).includes("storage_ref"));
  assert.ok(!JSON.stringify(body).includes("parties/pilot/"));
  assert.deepEqual(body.parameters, { resolution: "480P", ratio: "16:9", duration: 2, audio: false, watermark: false });
  const textOnly = buildAlibabaSubmitBody(buildCheapDemoRequest("job-1", "idem-1", "CAM-02"));
  assert.ok(!("reference_image" in (textOnly.input as Record<string, unknown>)));
  assert.ok(!("media" in (textOnly.input as Record<string, unknown>)));
});

test("cameo_demo serializes offline to the r2v model at 5s with a reference (no network)", async () => {
  // Zero provider network requests: the pinned fixture is pure serialization.
  const fixture = JSON.parse(readFileSync(resolve("test/fixtures/alibaba_cameo_request.json"), "utf8")) as {
    request: Record<string, unknown>;
    body: Record<string, unknown>;
  };
  const photoSha = createHash("sha256").update(readFileSync(resolve("test/fixtures/guest_photo.jpg"))).digest("hex");
  const request = buildCameoDemoRequest("job-cameo-1", "idem-cameo-1", "CAM-01", {
    objectPath: "parties/pilot/guests/p-guest001/ingest/gsub-guest001/photo.jpg",
    sha256: photoSha,
    consentRevision: "v1:2026-10-30T00:00:00.000Z",
    url: "https://signed.invalid/guest-photo.jpg",
  });
  assert.equal(request.modelId, "happyhorse-1.1-r2v");
  assert.equal(request.presetId, "cameo_demo");
  assert.equal(request.resolution, "480P");
  assert.equal(request.secondsOut, 5);
  assert.equal(request.audio, false);
  assert.equal(request.outputs, 1);
  assert.equal(request.autoUpscale, false);
  assert.equal(request.prompt, CAMEO_DEMO_PROMPT);
  assert.equal(request.prompt, fixture.request.prompt);
  const body = buildAlibabaSubmitBody(request);
  assert.deepEqual(body, fixture.body);
  assert.equal(body.model, "happyhorse-1.1-r2v");
  assert.equal((body.input as Record<string, unknown>).prompt, request.prompt);
  // Corrected r2v envelope: input.media carries the signed URL; sha256 stays
  // off the wire on the request/ledger path.
  assert.deepEqual((body.input as Record<string, unknown>).media, [{ type: "reference_image", url: "https://signed.invalid/guest-photo.jpg" }]);
  assert.ok(!("reference_image" in (body.input as Record<string, unknown>)));
  assert.ok(!JSON.stringify(body).includes(photoSha));
  assert.deepEqual(body.parameters, { resolution: "480P", ratio: "16:9", duration: 5, audio: false, watermark: false });
  // The private bucket path never leaves the backend: no storage_ref or
  // objectPath key survives serialization.
  assert.ok(!JSON.stringify(body).includes("storage_ref"));
  assert.ok(!JSON.stringify(body).includes("parties/pilot/"));
  // cheap_demo is untouched by the cameo mapping.
  assert.equal(buildCheapDemoRequest("job-1", "idem-1", "CAM-01").modelId, "wan3.0-video");
  assert.equal(CAMEO_DEMO_PRESET.secondsOut, 5);
});

test("unsigned and internal reference paths are rejected before transport (no network)", async () => {
  // Zero provider network requests: every case fails closed in serialization.
  let fetches = 0;
  const provider = new AlibabaVideoGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    fetchImpl: async () => { fetches += 1; return new Response("{}", { status: 200 }); },
  });
  const base = {
    objectPath: "parties/pilot/guests/p-guest001/ingest/gsub-guest001/photo.jpg",
    sha256: "9".repeat(64),
    consentRevision: "v1:2026-10-30T00:00:00.000Z",
  };
  // Bare internal bucket path with no signed URL.
  const bare = buildCameoDemoRequest("job-cameo-1", "idem-cameo-1", "CAM-01", { ...base });
  assert.throws(() => buildAlibabaSubmitBody(bare), /signed https URL/);
  await assert.rejects(provider.submit(bare), /signed https URL/);
  // Non-https URL schemes are rejected at the binding boundary itself.
  for (const url of ["http://signed.invalid/guest-photo.jpg", "gs://bucket/parties/pilot/photo.jpg"]) {
    assert.throws(() => buildCameoDemoRequest("job-cameo-1", "idem-cameo-1", "CAM-01", { ...base, url }), /signed https URL/);
  }
  // Same gate for guest-bound cheap_demo references.
  const cheapBare = buildCheapDemoRequest("job-guest-1", "idem-guest-1", "CAM-01", { ...base });
  assert.throws(() => buildAlibabaSubmitBody(cheapBare), /signed https URL/);
  await assert.rejects(provider.submit(cheapBare), /signed https URL/);
  assert.equal(fetches, 0);
});

test("resolved reference serializes to the fetchable https URL form (no network)", async () => {
  // Zero provider network requests: pure offline serialization.
  const photoSha = createHash("sha256").update(readFileSync(resolve("test/fixtures/guest_photo.jpg"))).digest("hex");
  const url = "https://signed.invalid/guest-photo.jpg?token=abc123";
  const request = buildCameoDemoRequest("job-cameo-1", "idem-cameo-1", "CAM-01", {
    objectPath: "parties/pilot/guests/p-guest001/ingest/gsub-guest001/photo.jpg",
    sha256: photoSha,
    consentRevision: "v1:2026-10-30T00:00:00.000Z",
    url,
  });
  const body = buildAlibabaSubmitBody(request);
  const wire = body.input as Record<string, unknown>;
  assert.deepEqual(wire.media, [{ type: "reference_image", url }]);
  assert.ok(((wire.media as Array<Record<string, unknown>>)[0].url as string).startsWith("https://"));
  assert.ok(!("reference_image" in wire));
  assert.ok(!JSON.stringify(body).includes(photoSha));
  assert.ok(!("storage_ref" in wire));
  assert.ok(!("objectPath" in wire));
});

test("cartoon still seed is constrained to signed int32 (live 400 regression, no network)", () => {
  // Live qwen-image-3.0-pro submit returned HTTP 400 InvalidParameter for a
  // seed of 3399556814 (> 2147483647): the Token Plan image route expects a
  // signed 32-bit seed. Zero provider network: pure offline derivation.
  const INT32_MAX = 2147483647;
  const MOD = 2147483648;
  // The exact previously-failing raw material now maps in-range.
  assert.equal(3399556814 % MOD, 1252073166);
  assert.ok(1252073166 >= 0 && 1252073166 <= INT32_MAX);
  // Known-good seed stays byte-identical (modulo is a no-op below 2**31).
  assert.equal(30102026 % MOD, 30102026);
  // Pinned fixture key is below the boundary: its seed is unchanged.
  assert.equal(cartoonStillSeed("job-cartoon-1:still:attic-computer-corner:cramped-stumble-chase"), 311071940);
  // Determinism: same key -> same seed.
  const key = "job-cartoon-1:still:attic-computer-corner:cramped-stumble-chase";
  assert.equal(cartoonStillSeed(key), cartoonStillSeed(key));
  // Independent re-derivation (not the function under test): seed must equal
  // raw-8-hex mod 2**31 for a sweep of live-shaped keys, always in-range.
  for (let i = 0; i < 50; i += 1) {
    const candidate = `job-cartoon-${i}:still:attic-computer-corner:cramped-stumble-chase`;
    const raw = Number.parseInt(createHash("sha256").update(candidate).digest("hex").slice(0, 8), 16);
    const seed = cartoonStillSeed(candidate);
    assert.equal(seed, raw % MOD);
    assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed <= INT32_MAX, `seed out of range for ${candidate}`);
  }
  // At least one swept key has a raw value above INT32_MAX (proves the sweep
  // exercises the previously-rejected region rather than passing vacuously).
  const raws = Array.from({ length: 50 }, (_, i) =>
    Number.parseInt(createHash("sha256").update(`job-cartoon-${i}:still:attic-computer-corner:cramped-stumble-chase`).digest("hex").slice(0, 8), 16));
  assert.ok(raws.some((raw) => raw > INT32_MAX), "sweep must cover raw values above signed int32");
});

function tinyCartoonStillRequest(idempotencyKey: string): CartoonStillRequest {
  const subjectBytes = new Uint8Array([1, 2, 3, 4]);
  const styleBytes = new Uint8Array([5, 6, 7, 8]);
  return {
    jobId: "job-cartoon-1",
    idempotencyKey,
    prompt: "test still prompt",
    negativePrompt: "test negative",
    modelId: "qwen-image-3.0-pro",
    region: "singapore",
    references: [
      { role: "subject_identity", bytes: subjectBytes, sha256: createHash("sha256").update(subjectBytes).digest("hex"), contentType: "image/jpeg" },
      { role: "style_scene", bytes: styleBytes, sha256: createHash("sha256").update(styleBytes).digest("hex"), contentType: "image/jpeg" },
    ],
  };
}

test("cartoon still body keeps the verified wire shape with an in-range seed (no network)", () => {
  // Zero provider network requests: pure offline serialization. The wire
  // shape is byte-for-byte the verified sync multimodal form; only the seed
  // derivation changed (modulo 2**31).
  const body = buildAlibabaImageSubmitBody(tinyCartoonStillRequest("job-cartoon-1:still:attic-computer-corner:cramped-stumble-chase"));
  assert.equal(body.model, "qwen-image-3.0-pro");
  const messages = (body.input as { messages: Array<{ role: string; content: Array<Record<string, string>> }> }).messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content.length, 3);
  assert.match(String(messages[0].content[0].image), /^data:image\/jpeg;base64,/);
  assert.match(String(messages[0].content[1].image), /^data:image\/jpeg;base64,/);
  assert.equal(messages[0].content[2].text, "test still prompt");
  const parameters = body.parameters as Record<string, unknown>;
  assert.equal(parameters.size, "1024*768");
  assert.equal(parameters.n, 1);
  assert.equal(parameters.seed, 311071940);
  assert.ok(typeof parameters.seed === "number" && (parameters.seed as number) >= 0 && (parameters.seed as number) <= 2147483647);
  assert.equal(parameters.prompt_extend, false);
  assert.equal(parameters.enable_thinking, false);
  assert.equal(parameters.watermark, false);
  assert.equal(parameters.negative_prompt, "test negative");
  // Schema parity with the pinned verified fixture (same keys, same flags).
  const fixture = JSON.parse(readFileSync(resolve("test/fixtures/alibaba_cartoon_still_request.json"), "utf8")) as {
    body: { model: string; input: Record<string, unknown>; parameters: Record<string, unknown> };
  };
  assert.equal(fixture.body.model, body.model);
  assert.deepEqual(Object.keys(fixture.body.parameters).sort(), Object.keys(parameters).sort());
  assert.equal(fixture.body.parameters.size, parameters.size);
  assert.equal(fixture.body.parameters.n, parameters.n);
  assert.equal(fixture.body.parameters.prompt_extend, parameters.prompt_extend);
  assert.equal(fixture.body.parameters.enable_thinking, parameters.enable_thinking);
  assert.equal(fixture.body.parameters.watermark, parameters.watermark);
  assert.ok(typeof fixture.body.parameters.seed === "number" && (fixture.body.parameters.seed as number) >= 0 && (fixture.body.parameters.seed as number) <= 2147483647);
});

test("image submit failure surfaces the sanitized provider message detail (no network)", async () => {
  // Zero provider network requests: stubbed transport replays a 400 with a
  // code plus a message carrying a URL and a token; both must be redacted
  // while the human-readable detail survives for diagnosis.
  const failing = new AlibabaImageGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    fetchImpl: async () => new Response(JSON.stringify({
      code: "InvalidParameter",
      message: "Parameter seed out of range, see https://provider.invalid/docs and Bearer secret-token",
    }), { status: 400 }),
  });
  await assert.rejects(failing.submit(tinyCartoonStillRequest("job-cartoon-1:still:attic-computer-corner:cramped-stumble-chase")), (error: unknown) => {
    assert.ok(error instanceof AlibabaSubmissionError);
    assert.equal(error.certainty, "non_billable");
    assert.equal(error.retryable, false);
    assert.ok(error.message.includes("InvalidParameter"), "code must survive for diagnosis");
    assert.ok(error.message.includes("Parameter seed out of range"), "message detail must survive for diagnosis");
    assert.ok(!error.message.includes("https://provider.invalid/docs"), "URLs must stay redacted");
    assert.ok(!error.message.includes("secret-token"), "tokens must stay redacted");
    assert.ok(!error.message.includes("fixture-key"), "API key must never leak into errors");
    return true;
  });
  // Ambiguous failures stay unknown without leaking anything.
  const flaky = new AlibabaImageGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    fetchImpl: async () => new Response(JSON.stringify({ code: "Throttling", message: "slow down" }), { status: 429 }),
  });
  await assert.rejects(flaky.submit(tinyCartoonStillRequest("job-cartoon-1:still:attic-computer-corner:cramped-stumble-chase")), (error: unknown) =>
    error instanceof AlibabaSubmissionError && error.certainty === "unknown" && error.retryable === false);
});
test("polled FAILED surfaces the provider code/message and redacts URLs (no network)", async () => {
  // Zero provider network requests: stubbed transport replays a FAILED poll.
  const failedBody = {
    output: {
      task_status: "FAILED",
      code: "InvalidParameter",
      message: "Field required: input.media, see https://provider.invalid/docs and Bearer secret-token",
    },
  };
  const provider = new AlibabaVideoGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    fetchImpl: async () => new Response(JSON.stringify(failedBody), { status: 200 }),
  });
  const status = await provider.getStatus("task-fixture-failed");
  assert.equal(status.state, "FAILED");
  assert.equal(status.errorCode, "InvalidParameter");
  assert.ok(typeof status.errorMessage === "string" && status.errorMessage.includes("Field required: input.media"));
  assert.ok(!status.errorMessage!.includes("https://provider.invalid/docs"));
  assert.ok(!status.errorMessage!.includes("secret-token"));
  // Empty reasons keep the legacy generic mapping (code fallback only).
  const emptyProvider = new AlibabaVideoGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    fetchImpl: async () => new Response(JSON.stringify({ output: { task_status: "FAILED" } }), { status: 200 }),
  });
  const empty = await emptyProvider.getStatus("task-fixture-empty");
  assert.equal(empty.state, "FAILED");
  assert.equal(empty.errorCode, "PROVIDER_ERROR");
  assert.equal(empty.errorMessage, undefined);
});

test("bounded video submit timeout surfaces certainty unknown, never non_billable", async () => {
  // Hung POST regression: the fetch never resolves unless aborted; the short
  // timeout must abort it and classify the outcome as unknown.
  const hanging = new AlibabaVideoGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    submitTimeoutMs: 10,
    fetchImpl: ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
      })) as typeof fetch,
  });
  await assert.rejects(hanging.submit(buildCheapDemoRequest("job-1", "idem-1", "CAM-01")), (error: unknown) =>
    error instanceof AlibabaSubmissionError && error.certainty === "unknown" && error.retryable === false);
});

test("bounded video status/result timeouts surface unknown, never success", async () => {
  const hanging = new AlibabaVideoGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    statusTimeoutMs: 10,
    resultTimeoutMs: 10,
    fetchImpl: ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
      })) as typeof fetch,
  });
  await assert.rejects(hanging.getStatus("task-fixture-001"), (error: unknown) =>
    error instanceof AlibabaSubmissionError && error.certainty === "unknown");
  await assert.rejects(hanging.getResult("task-fixture-001"), (error: unknown) =>
    error instanceof AlibabaSubmissionError && error.certainty === "unknown");
});

test("bounded image POST timeout surfaces certainty unknown, never non_billable", async () => {
  const hanging = new AlibabaImageGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    submitTimeoutMs: 10,
    fetchImpl: ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
      })) as typeof fetch,
  });
  await assert.rejects(
    hanging.submit(tinyCartoonStillRequest("job-cartoon-1:still:timeout-reg")),
    (error: unknown) => error instanceof AlibabaSubmissionError && error.certainty === "unknown" && error.retryable === false,
  );
});

test("bounded reference-image fetch timeout surfaces certainty unknown", async () => {
  const syncBody = {
    output: {
      request_id: "req-ref-timeout-1",
      choices: [{ message: { content: [{ image: "https://cdn.invalid/still-timeout.png" }] } }],
    },
  };
  const refHanging = new AlibabaImageGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    submitTimeoutMs: 5_000,
    referenceFetchTimeoutMs: 10,
    fetchImpl: (async (url: unknown, init?: { signal?: AbortSignal }) => {
      if (String(url).startsWith("https://cdn.invalid/")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
        });
      }
      return new Response(JSON.stringify(syncBody), { status: 200 });
    }) as typeof fetch,
  });
  await assert.rejects(
    refHanging.submit(tinyCartoonStillRequest("job-cartoon-1:still:ref-timeout")),
    (error: unknown) => error instanceof AlibabaSubmissionError && error.certainty === "unknown",
  );
});

test("no-timeout regression guard: every provider fetch call site passes an AbortSignal", async () => {
  const seen: Array<AbortSignal | undefined> = [];
  const capturing = (body: unknown, status = 200) =>
    (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      seen.push(init?.signal);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  // Video submit + status + result.
  const video = new AlibabaVideoGenerationPort({
    apiKey: "fixture-key", workspaceId: "workspace", fetchImpl: capturing(fixture.submit),
  });
  await video.submit(buildCheapDemoRequest("job-1", "idem-1", "CAM-01"));
  assert.ok(seen[0] instanceof AbortSignal, "video submit must carry an AbortSignal timeout");
  const videoPoll = new AlibabaVideoGenerationPort({
    apiKey: "fixture-key", workspaceId: "workspace", fetchImpl: capturing(fixture.succeeded),
  });
  await videoPoll.getStatus("task-fixture-001");
  await videoPoll.getResult("task-fixture-001");
  // Image POST.
  const image = new AlibabaImageGenerationPort({
    apiKey: "fixture-key", workspaceId: "workspace", fetchImpl: capturing({
      output: { request_id: "req-signal-guard", choices: [{ message: { content: [{ image: "data:image/png;base64,AQID" }] } }] },
    }),
  });
  await image.submit(tinyCartoonStillRequest("job-cartoon-1:still:signal-guard"));
  // Reference-image https fetch.
  const refSeen: Array<AbortSignal | undefined> = [];
  const refPort = new AlibabaImageGenerationPort({
    apiKey: "fixture-key",
    workspaceId: "workspace",
    fetchImpl: (async (url: unknown, init?: { signal?: AbortSignal }) => {
      if (String(url).startsWith("https://cdn.invalid/")) {
        refSeen.push(init?.signal);
        return new Response(await Promise.resolve(new Uint8Array([9, 9]).buffer as ArrayBuffer), { status: 200 });
      }
      return new Response(JSON.stringify({
        output: { request_id: "req-ref-signal", choices: [{ message: { content: [{ image: "https://cdn.invalid/g.png" }] } }] },
      }), { status: 200 });
    }) as typeof fetch,
  });
  await refPort.submit(tinyCartoonStillRequest("job-cartoon-1:still:ref-signal"));
  for (const signal of [...seen, ...refSeen]) {
    assert.ok(signal instanceof AbortSignal, "every provider fetch call site must pass a signal");
  }
  assert.ok(refSeen.length === 1 && refSeen[0] instanceof AbortSignal, "reference-image fetch must carry an AbortSignal timeout");
});
