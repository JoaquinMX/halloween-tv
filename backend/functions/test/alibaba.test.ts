import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { AlibabaSubmissionError, AlibabaVideoGenerationPort, buildAlibabaSubmitBody } from "../src/providers/alibaba";
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
  assert.deepEqual((body.input as Record<string, unknown>).media, ["https://signed.invalid/guest-photo.jpg"]);
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
  assert.deepEqual((body.input as Record<string, unknown>).media, ["https://signed.invalid/guest-photo.jpg"]);
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
  assert.deepEqual(wire.media, [url]);
  assert.ok(((wire.media as unknown[])[0] as string).startsWith("https://"));
  assert.ok(!("reference_image" in wire));
  assert.ok(!JSON.stringify(body).includes(photoSha));
  assert.ok(!("storage_ref" in wire));
  assert.ok(!("objectPath" in wire));
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
