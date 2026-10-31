import {
  ProviderResult,
  ProviderSubmission,
  ProviderTaskStatus,
  VideoGenerationPort,
  VideoGenerationRequest,
  validateFetchableReferenceImage,
  validateVideoGenerationRequest,
} from "../video_generation_port";

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
    input.media = [request.referenceImage.url];
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
        body: JSON.stringify(buildAlibabaSubmitBody(request)),
      });
    } catch {
      // A network failure has an unknown outcome: the server may have accepted it.
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
    const response = await this.getTask(taskId);
    if (!response.ok) throw new Error(`Alibaba status request failed (${response.status}).`);
    return parseStatus(await response.json());
  }

  async getResult(taskId: string): Promise<ProviderResult> {
    const response = await this.getTask(taskId);
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

  private getTask(taskId: string): Promise<Response> {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error("Alibaba task ID is invalid.");
    return this.fetchImpl(`${this.baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
    });
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
