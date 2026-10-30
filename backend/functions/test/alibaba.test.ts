import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { AlibabaSubmissionError, AlibabaVideoGenerationPort, buildAlibabaSubmitBody } from "../src/providers/alibaba";
import { buildCheapDemoRequest } from "../src/video_generation_port";

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
  assert.deepEqual((body.input as Record<string, unknown>).reference_image, {
    storage_ref: "parties/pilot/guests/p-guest001/ingest/gsub-guest001/photo.jpg",
    sha256: photoSha,
  });
  assert.deepEqual(body.parameters, { resolution: "480P", ratio: "16:9", duration: 2, audio: false, watermark: false });
  const textOnly = buildAlibabaSubmitBody(buildCheapDemoRequest("job-1", "idem-1", "CAM-02"));
  assert.ok(!("reference_image" in (textOnly.input as Record<string, unknown>)));
});
