import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProviderResult } from "./video_generation_port";

const MAX_SOURCE_BYTES = 250 * 1024 * 1024;

export interface NormalizedVideo {
  path: string;
  sha256: string;
  sizeBytes: number;
  durationMs: number;
}

export interface NormalizationOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  fetchImpl?: typeof fetch;
  tempRoot?: string;
  /**
   * Locked delivery duration for this job. Defaults to the cheap_demo 2s
   * profile; the STEP 2 cameo batch passes 5. Anything else is rejected.
   */
  expectedSecondsOut?: 2 | 5;
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-12000); });
    child.once("error", () => reject(new Error(`${command} could not be started.`)));
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} failed (${code}): ${stderr.slice(-2000)}`));
    });
  });
}

async function resolveSource(result: ProviderResult, path: string, fetchImpl: typeof fetch): Promise<void> {
  if (result.video.kind === "file") {
    await copyFile(result.video.value, path);
  } else {
    const url = new URL(result.video.value);
    if (url.protocol !== "https:") throw new Error("Provider video URL must use HTTPS.");
    const response = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Provider video download failed (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOURCE_BYTES) {
      throw new Error("Provider video size is outside the supported range.");
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !contentType.toLowerCase().includes("video/") && !contentType.toLowerCase().includes("application/octet-stream")) {
      throw new Error("Provider result is not a video file.");
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, bytes, { mode: 0o600 });
  }
  const sourceStat = await stat(path);
  if (sourceStat.size <= 0 || sourceStat.size > MAX_SOURCE_BYTES) throw new Error("Provider video size is outside the supported range.");
}

/** Downloads a provider result and transcodes it to the fixed delivery profile. */
export async function normalizeProviderVideo(
  result: ProviderResult,
  options: NormalizationOptions = {},
): Promise<NormalizedVideo> {
  const expectedSecondsOut = options.expectedSecondsOut ?? 2;
  if (result.secondsOut !== expectedSecondsOut || result.secondsIn !== 0) {
    throw new Error(expectedSecondsOut === 5
      ? "Provider result does not match the five-second cameo reference preset."
      : "Provider result does not match the two-second text-only preset.");
  }
  const directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), "halloween-generation-"));
  const source = join(directory, "source.mp4");
  const output = join(directory, "normalized.mp4");
  try {
    await resolveSource(result, source, options.fetchImpl ?? fetch);
    const filter = `fps=24,scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=${expectedSecondsOut}`;
    // The prepared runtime profile pins the cheap_demo two-second path, which
    // keeps the literal "-t", "2" construction the deploy preflight greps for.
    const durationArgs = expectedSecondsOut === 5 ? ["-t", "5"] : ["-t", "2"];
    await run(options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source,
      "-an", "-vf", filter, ...durationArgs, "-r", "24", "-c:v", "libx264",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", output,
    ]);
    const probe = await run(options.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=codec_name,pix_fmt,r_frame_rate,width,height:format=duration",
      "-of", "json", output,
    ]);
    const parsed = JSON.parse(probe.stdout) as {
      streams?: Array<{ codec_name?: string; pix_fmt?: string; r_frame_rate?: string; width?: number; height?: number }>;
      format?: { duration?: string };
    };
    const video = parsed.streams?.[0];
    const durationMs = Math.round(Number(parsed.format?.duration) * 1000);
    const expectedDurationMs = expectedSecondsOut * 1000;
    if (video?.codec_name !== "h264" || video.pix_fmt !== "yuv420p" || video.r_frame_rate !== "24/1" ||
        video.width !== 854 || video.height !== 480 || durationMs !== expectedDurationMs) {
      throw new Error(`FFmpeg output did not match H.264/yuv420p/24fps/480P/${expectedSecondsOut === 5 ? "five-second" : "two-second"} profile.`);
    }
    const bytes = await readFile(output);
    if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) throw new Error("Normalized output size is outside the supported range.");
    return {
      path: output,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      durationMs,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Call after the staged bytes have been uploaded. */
export async function removeNormalizedVideo(video: NormalizedVideo): Promise<void> {
  await rm(dirname(video.path), { recursive: true, force: true });
}
