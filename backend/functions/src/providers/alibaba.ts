import {
  ProviderResult,
  ProviderSubmission,
  ProviderTaskStatus,
  VideoGenerationPort,
  VideoGenerationRequest,
  validateCartoonFirstFrame,
  validateFetchableCartoonFirstFrame,
  validateFetchableReferenceImage,
  validateVideoGenerationRequest,
} from "../video_generation_port";
import { CARTOON_VIDEO_PRESET } from "../contracts";

const SUBMIT_PATH = "/api/v1/services/aigc/video-generation/video-synthesis";
const DEFAULT_REGION_HOST = "ap-southeast-1.maas.aliyuncs.com";

export type SubmissionCertainty = "non_billable" | "unknown";

/** Submission failures retain whether Alibaba definitively rejected the request. */
export class AlibabaSubmissionError extends Error {
  constructor(message: string, readonly certainty: SubmissionCertainty, readonly retryable: boolean) {
    super(message);
    this.name = "AlibabaSubmissionError";
  }
}

export interface AlibabaProviderOptions {
  apiKey: string;
  workspaceId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Test/ops override for the bounded submit timeout (ms). Defaults to ALIBABA_SUBMIT_TIMEOUT_MS. */
  submitTimeoutMs?: number;
  /** Test/ops override for the bounded status-poll timeout (ms). Defaults to ALIBABA_STATUS_TIMEOUT_MS. */
  statusTimeoutMs?: number;
  /** Test/ops override for the bounded result-fetch timeout (ms). Defaults to ALIBABA_RESULT_TIMEOUT_MS. */
  resultTimeoutMs?: number;
  /** Generic override applied when a stage-specific override is absent. */
  timeoutMs?: number;
}

/**
 * Bounded provider fetch timeouts (live-forensics hardening, rollout-5).
 * Every Alibaba video fetch path carries an AbortSignal with one of these
 * budgets so a hung POST/poll can never wedge a worker with no logs:
 * submit 30s (schedule path), status poll 30s, result fetch 30s. A timeout
 * aborts the fetch and surfaces as certainty "unknown" (never non_billable),
 * never as success — unknown outcomes are reconciled, never resubmitted.
 */
export const ALIBABA_SUBMIT_TIMEOUT_MS = 30_000;
export const ALIBABA_STATUS_TIMEOUT_MS = 30_000;
export const ALIBABA_RESULT_TIMEOUT_MS = 30_000;

/** Builds a timeout signal without leaking timers on the hot path. */
export function alibabaTimeoutSignal(timeoutMs: number): AbortSignal {
  if (typeof (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout === "function") {
    return (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

/** True for AbortSignal timeouts (AbortError/TimeoutError); never success, never non_billable. */
export function isAlibabaTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function effectiveTimeoutMs(explicit: number | undefined, fallback: number | undefined, def: number): number {
  const candidate = explicit ?? fallback ?? def;
  return Number.isFinite(candidate) && (candidate as number) > 0 ? (candidate as number) : def;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function responseError(value: unknown): string {
  const root = record(value);
  const code = typeof root?.code === "string" ? root.code : "PROVIDER_ERROR";
  return code.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

/**
 * Redacts credentials and fetchable URLs from a provider failure reason so
 * the text is safe to surface in worker errors and persist on the job doc.
 * Truncated to a bounded length; never emits raw URLs, tokens, or key
 * material.
 */
export function sanitizeProviderReasonText(value: unknown, maxLength = 280): string {
  let text = typeof value === "string" ? value : "";
  text = text.replace(/https?:\/\/\S+/gi, "[url]");
  text = text.replace(/wss?:\/\/\S+/gi, "[url]");
  text = text.replace(/gs:\/\/\S+/gi, "[url]");
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/_=-]+/gi, "Bearer [redacted]");
  text = text.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
  text = text.replace(/[\u0000-\u001f\u007f]+/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text.slice(0, maxLength);
}

function parseStatus(value: unknown): ProviderTaskStatus {
  const root = record(value);
  const output = record(root?.output);
  const rawState = output?.task_status ?? root?.task_status;
  if (rawState === "PENDING" || rawState === "RUNNING") return { state: rawState };
  if (rawState === "SUCCEEDED") return { state: "SUCCEEDED" };
  if (rawState === "FAILED" || rawState === "CANCELED" || rawState === "CANCELLED") {
    const source = output?.code !== undefined || output?.message !== undefined ? output : root;
    const message = sanitizeProviderReasonText(
      typeof source?.message === "string" ? source.message : source?.reason,
    );
    const status: ProviderTaskStatus = { state: "FAILED", errorCode: responseError(source) };
    if (message) status.errorMessage = message;
    return status;
  }
  throw new Error("Alibaba returned an unrecognized task state.");
}

/** Pure request serialization: covered offline by the guest-request fixture, zero network. */
export function buildAlibabaSubmitBody(request: VideoGenerationRequest): {
  model: string;
  input: Record<string, unknown>;
  parameters: Record<string, unknown>;
} {
  validateVideoGenerationRequest(request);
  const input: Record<string, unknown> = { prompt: request.prompt };
  if (request.referenceImage !== undefined) {
    // Provider-fetchable reference form: the worker resolves the guest photo
    // to a short-lived signed https read URL (GCS v4 read signature, 15-min
    // TTL, in-flight API call only, never persisted) and the adapter sends it
    // as the wire-level `input.media` field, exactly as the r2v endpoint
    // requires (`input: { prompt, media: [<signed https URL>] }`). The sha256
    // stays on the VideoGenerationRequest / usage-ledger path for provenance
    // and is never part of the submitted JSON: live submits carrying
    // `input.reference_image` (+ sha256) fail at schedule time with
    // InvalidParameter "Field required: input.media", and submits carrying
    // `input.media` as a bare string fail with InvalidParameter
    // "Input should be a valid list, input.media". Bare paths /
    // non-https / missing media are rejected by the fetchability gate below
    // before transport, so an unfetchable reference can never be submitted.
    // No objectPath/storage_ref is ever sent.
    validateFetchableReferenceImage(request.referenceImage);
    input.media = [{ type: "reference_image", url: request.referenceImage.url }];
  }
  return {
    model: request.modelId,
    input,
    parameters: {
      resolution: request.resolution,
      ratio: request.aspectRatio,
      duration: request.secondsOut,
      audio: request.audio,
      watermark: false,
    },
  };
}

/**
 * Pure cartoon video serialization (offline, zero network): wan3.0-video
 * STANDARD cheap_demo envelope (2s/480P/silent/no-watermark/prompt_extend
 * false) animating the exact generated still as first_frame.
 *
 * Verified wire shape (owner-approved v2 manifests): the still travels as an
 * in-process data URI inside `input.media` as
 * `{ type: "first_frame", url: <data:image/...;base64> }` — never as
 * `input.first_frame`, never as hosted bytes. The still sha256 stays on the
 * request/ledger path for chain provenance and never enters the submitted
 * JSON. The motion prompt is used verbatim: no suffix is appended here, so a
 * situation's own camera language (e.g. a side-tracking shot) is never
 * globally negated.
 */
export function buildAlibabaCartoonVideoBody(request: VideoGenerationRequest): {
  model: string;
  input: Record<string, unknown>;
  parameters: Record<string, unknown>;
} {
  validateVideoGenerationRequest(request);
  if (request.firstFrame === undefined) {
    throw new Error("Cartoon video requires the generated still as first_frame.");
  }
  validateCartoonFirstFrame(request.firstFrame);
  validateFetchableCartoonFirstFrame(request.firstFrame);
  if (typeof request.firstFrame.url !== "string" || !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(request.firstFrame.url)) {
    throw new Error("Cartoon video first frame must be an in-process data URI; hosted bytes are never submitted.");
  }
  if (request.modelId !== CARTOON_VIDEO_PRESET.modelId ||
      request.resolution !== CARTOON_VIDEO_PRESET.resolution ||
      request.secondsOut !== CARTOON_VIDEO_PRESET.secondsOut ||
      request.aspectRatio !== CARTOON_VIDEO_PRESET.aspectRatio ||
      request.audio !== CARTOON_VIDEO_PRESET.audio ||
      request.outputs !== CARTOON_VIDEO_PRESET.outputs ||
      request.autoUpscale !== CARTOON_VIDEO_PRESET.autoUpscale) {
    throw new Error("Cartoon video controls must match the fixed STANDARD cheap_demo envelope.");
  }
  return {
    model: request.modelId,
    input: {
      prompt: request.prompt,
      media: [{ type: "first_frame", url: request.firstFrame.url }],
    },
    parameters: {
      resolution: request.resolution,
      ratio: request.aspectRatio,
      duration: request.secondsOut,
      audio: request.audio,
      watermark: false,
      prompt_extend: false,
      video_control: CARTOON_VIDEO_PRESET.videoControl,
    },
  };
}
/** Alibaba Model Studio's asynchronous Wan video API, pinned to Singapore. */
export class AlibabaVideoGenerationPort implements VideoGenerationPort {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: AlibabaProviderOptions) {
    if (!options.apiKey.trim() || !options.workspaceId.trim()) {
      throw new Error("Alibaba API key and workspace ID must be configured server-side.");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? `https://${options.workspaceId}.${DEFAULT_REGION_HOST}`).replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    if (parsed.protocol !== "https:" ||
        !(parsed.hostname.endsWith(`.${DEFAULT_REGION_HOST}`) || parsed.hostname === "dashscope-intl.aliyuncs.com")) {
      throw new Error("Alibaba provider endpoint must use the Singapore region over HTTPS.");
    }
  }

  async submit(request: VideoGenerationRequest): Promise<ProviderSubmission> {
    validateVideoGenerationRequest(request);
    // Cartoon CAM-01 animates the exact generated still: the STANDARD envelope
    // serializes with first_frame; every other request keeps the locked body.
    const submitBody = request.firstFrame !== undefined
      ? buildAlibabaCartoonVideoBody(request)
      : buildAlibabaSubmitBody(request);
    const submitTimeoutMs = effectiveTimeoutMs(
      this.options.submitTimeoutMs, this.options.timeoutMs, ALIBABA_SUBMIT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${SUBMIT_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          "X-DashScope-Async": "enable",
          "X-DashScope-Idempotency-Key": request.idempotencyKey,
        },
        body: JSON.stringify(submitBody),
        signal: alibabaTimeoutSignal(submitTimeoutMs),
      });
    } catch (error) {
      // A network failure OR a bounded-timeout abort has an unknown outcome:
      // the server may have accepted it. Certainty stays "unknown" (never
      // non_billable); the worker reconciles instead of resubmitting blindly.
      throw new AlibabaSubmissionError("Alibaba submission outcome is unknown.", "unknown", false);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AlibabaSubmissionError("Alibaba returned an invalid submission response.", "unknown", false);
    }
    const root = record(body);
    const output = record(root?.output);
    if (!response.ok) {
      const definitivelyRejected = response.status >= 400 && response.status < 500 &&
        response.status !== 408 && response.status !== 429;
      throw new AlibabaSubmissionError(
        `Alibaba rejected the submission (${responseError(body)}).`,
        definitivelyRejected ? "non_billable" : "unknown",
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    const taskId = output?.task_id ?? root?.task_id;
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new AlibabaSubmissionError("Alibaba accepted no identifiable task.", "unknown", false);
    }
    return { taskId };
  }

  async getStatus(taskId: string): Promise<ProviderTaskStatus> {
    const response = await this.getTask(taskId, effectiveTimeoutMs(
      this.options.statusTimeoutMs, this.options.timeoutMs, ALIBABA_STATUS_TIMEOUT_MS));
    if (!response.ok) throw new Error(`Alibaba status request failed (${response.status}).`);
    return parseStatus(await response.json());
  }

  async getResult(taskId: string): Promise<ProviderResult> {
    const response = await this.getTask(taskId, effectiveTimeoutMs(
      this.options.resultTimeoutMs, this.options.timeoutMs, ALIBABA_RESULT_TIMEOUT_MS));
    if (!response.ok) throw new Error(`Alibaba result request failed (${response.status}).`);
    const body = await response.json();
    const root = record(body);
    const output = record(root?.output);
    const videoUrl = output?.video_url;
    if (typeof videoUrl !== "string" || !/^https:\/\//.test(videoUrl)) {
      throw new Error("Alibaba completed without a secure video URL.");
    }
    const usage = record(root?.usage);
    if (usage?.video_count !== undefined && usage.video_count !== 1) {
      throw new Error("Alibaba returned an output count outside the locked preset.");
    }
    const duration = typeof usage?.duration === "number" && Number.isFinite(usage.duration)
      ? usage.duration
      : 2;
    // Reference inputs can bill input duration: surfaced as secondsIn for the
    // usage ledger, never estimated. Image references carry no input-video
    // seconds; the realized console Credits stay the only billable truth.
    const inputDuration = typeof usage?.input_video_duration === "number" && Number.isFinite(usage.input_video_duration)
      ? usage.input_video_duration
      : 0;
    const credits = typeof usage?.credits_charged === "number" && Number.isFinite(usage.credits_charged)
      ? usage.credits_charged
      : null;
    return {
      video: { kind: "url", value: videoUrl },
      secondsOut: duration,
      secondsIn: inputDuration,
      creditsCharged: credits,
    };
  }

  private async getTask(taskId: string, timeoutMs: number): Promise<Response> {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error("Alibaba task ID is invalid.");
    let signal: AbortSignal;
    try {
      signal = alibabaTimeoutSignal(timeoutMs);
    } catch {
      throw new AlibabaSubmissionError("Alibaba task query outcome is unknown.", "unknown", false);
    }
    // A bounded-timeout abort surfaces as certainty "unknown" (never
    // non_billable), never as success: the poller reconciles the task ID.
    try {
      return await this.fetchImpl(`${this.baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        signal,
      });
    } catch (error) {
      if (isAlibabaTimeoutError(error)) {
        throw new AlibabaSubmissionError("Alibaba task query timed out; outcome is unknown.", "unknown", false);
      }
      throw error;
    }
  }
}

export function createAlibabaProviderFromEnvironment(fetchImpl?: typeof fetch): AlibabaVideoGenerationPort {
  return new AlibabaVideoGenerationPort({
    apiKey: process.env.ALIBABA_API_KEY ?? "",
    workspaceId: process.env.ALIBABA_WORKSPACE_ID ?? "",
    ...(process.env.ALIBABA_VIDEO_API_BASE_URL ? { baseUrl: process.env.ALIBABA_VIDEO_API_BASE_URL } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
