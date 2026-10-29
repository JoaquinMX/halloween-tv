import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { normalizeProviderVideo, removeNormalizedVideo } from "../src/normalize";
import { FakeVideoGenerationPort } from "../src/providers/fake";
import { buildCheapDemoRequest } from "../src/video_generation_port";

test("FFmpeg normalization produces a hashed H.264/yuv420p 24fps faststart delivery file", async () => {
  const provider = new FakeVideoGenerationPort(resolve(process.cwd(), "../../apps/tv_app/assets"));
  const request = buildCheapDemoRequest("normalize-test", "normalize-test", "CAM-01");
  const submitted = await provider.submit(request);
  const result = await provider.getResult(submitted.taskId);
  const normalized = await normalizeProviderVideo(result);
  try {
    const bytes = await readFile(normalized.path);
    assert.equal(normalized.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(normalized.sizeBytes, bytes.byteLength);
    assert.equal(normalized.durationMs, 2000);
    const moovAt = bytes.indexOf(Buffer.from("moov"));
    const mdatAt = bytes.indexOf(Buffer.from("mdat"));
    assert.ok(moovAt >= 0 && mdatAt > moovAt, "faststart places the moov atom before media data");
  } finally {
    await removeNormalizedVideo(normalized);
  }
});

test("normalization rejects provider outputs outside the locked duration/input profile", async () => {
  await assert.rejects(normalizeProviderVideo({
    video: { kind: "file", value: "/does/not/get/read.mp4" },
    secondsOut: 5,
    secondsIn: 0,
    creditsCharged: 0,
  }), /two-second text-only preset/);
  await assert.rejects(normalizeProviderVideo({
    video: { kind: "file", value: "/does/not/get/read.mp4" },
    secondsOut: 2,
    secondsIn: 1,
    creditsCharged: 0,
  }), /two-second text-only preset/);
});
