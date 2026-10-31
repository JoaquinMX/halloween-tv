import { createHash } from "node:crypto";
import { AlibabaSubmissionError, sanitizeProviderReasonText } from "./alibaba";
import { CartoonStillRequest, CartoonStillResult, CartoonStillStatus, ImageGenerationPort, validateCartoonStillRequest } from "../image_generation_port";
import { sha256 } from "../cartoon_pipeline";

/**
 * Verified live still-stage transport (owner-approved v2 manifests — do not
 * invent variants). Synchronous Alibaba Token Plan multimodal generation:
 *
 *   POST https://token-plan.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
 *   Body: { model: 'qwen-image-3.0-pro',
 *           input: { messages: [{ role: 'user',
 *                     content: [{ image: <dataURI_style_scene> },
 *                              { image: <dataURI_subject> },
 *                              { text: <positivePrompt> }] }] },
 *           parameters: { size: '1024*768', n: 1, seed,
 *                         prompt_extend: false, enable_thinking: false,
 *                         watermark: false, negative_prompt } }
 *   Parse: output.choices[*].message.content[*].image
 *
 * No task polling: the call is synchronous. Both image references are
 * in-process data URIs (data:image/jpeg|png;base64) derived from the
 * validated reference bytes — NO public/signed hosting, NO resolveImageUrl
 * network hop. No other body shape is emitted by this adapter.
 */

const SYNC_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com";
const SYNC_PATH = "/api/v1/services/aigc/multimodal-generation/generation";

const DATA_URI_RE = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/;

function toDataUri(bytes: Uint8Array, contentType: "image/jpeg" | "image/png"): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Deterministic per-request seed from the immutable still idempotency key. */
export function cartoonStillSeed(idempotencyKey: string): number {
  return Number.parseInt(createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 8), 16);
}

/**
 * Pure request serialization: deterministic wire mapping for the still stage.
 * References are ordered style_scene then subject_identity per the verified
 * shape and serialized as in-process data URIs; the negative prompt rides as
 * parameters.negative_prompt. Zero network. Credits stay UNKNOWN (null): the
 * sync response carries no realized charge.
 */
export function buildAlibabaImageSubmitBody(
  request: CartoonStillRequest,
): { model: string; input: Record<string, unknown>; parameters: Record<string, unknown> } {
  validateCartoonStillRequest(request);
  const [subject, style] = request.references;
  if (subject.role !== "subject_identity" || style.role !== "style_scene") {
    throw new Error("Cartoon references must be ordered subject_identity then style_scene.");
  }
  for (const reference of request.references) {
    if (sha256(reference.bytes) !== reference.sha256) throw new Error("Cartoon reference digest mismatch.");
    if (reference.contentType !== "image/jpeg" && reference.contentType !== "image/png") {
      throw new Error("Cartoon reference content type is unsupported.");
    }
  }
  const styleUri = toDataUri(style.bytes, style.contentType);
  const subjectUri = toDataUri(subject.bytes, subject.contentType);
  for (const uri of [styleUri, subjectUri]) {
    if (!DATA_URI_RE.test(uri)) throw new Error("Cartoon reference data URI is malformed.");
  }
  return {
    model: request.modelId,
    input: {
      messages: [{
        role: "user",
        content: [
          { image: styleUri },
          { image: subjectUri },
          { text: request.prompt },
        ],
      }],
    },
    parameters: {
      size: "1024*768",
      n: 1,
      seed: cartoonStillSeed(request.idempotencyKey),
      prompt_extend: false,
      enable_thinking: false,
      watermark: false,
      negative_prompt: request.negativePrompt,
    },
  };
}

function record(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

/** Extracts the generated still image reference from a sync multimodal response. */
function parseSyncImageResult(body: unknown): { imageRef: string; taskId: string } {
  const root = record(body);
  const output = record(root?.output);
  const choices = output?.choices;
  if (!Array.isArray(choices)) throw new Error("Alibaba image response carries no output.choices.");
  const images: string[] = [];
  for (const choice of choices) {
    const message = record(record(choice)?.message);
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const image = record(item)?.image;
      if (typeof image === "string" && image.length > 0) images.push(image);
    }
  }
  if (!images.length) throw new Error("Alibaba image response carries no message.content image.");
  const first = images[0];
  const rawRequestId = typeof output?.request_id === "string" ? output.request_id : "";
  const taskId = rawRequestId
    ? `img_${rawRequestId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48)}`
    : `img_${createHash("sha256").update(first.slice(0, 256)).digest("hex").slice(0, 24)}`;
  return { imageRef: first, taskId };
}

function decodeDataUri(ref: string): Uint8Array {
  if (!DATA_URI_RE.test(ref)) throw new Error("Alibaba image data URI is malformed.");
  const bytes = new Uint8Array(Buffer.from(ref.slice(ref.indexOf(",") + 1), "base64"));
  if (!bytes.length) throw new Error("Alibaba image result is empty.");
  return bytes;
}

/**
 * qwen-image-3.0-pro adapter (Alibaba Singapore, Token Plan only).
 * Synchronous generation: one POST, no task polling. Durable reservation
 * semantics are preserved: the submit records a deterministic taskId derived
 * from the immutable still idempotency key, uncertain submissions (network
 * throw, 5xx/408/429) are explicitly non-retryable-blind
 * (AlibabaSubmissionError certainty "unknown"), and definitive client
 * rejections (other 4xx) are marked non_billable so the worker never
 * resubmits blindly. Unknown outcomes are reconciled, never resubmitted.
 */
export class AlibabaImageGenerationPort implements ImageGenerationPort {
  private readonly cache = new Map<string, CartoonStillResult & { taskId: string }>();

  constructor(private readonly options: { apiKey: string; workspaceId: string; fetchImpl?: typeof fetch }) {
    if (!options.apiKey.trim() || !options.workspaceId.trim()) {
      throw new Error("Alibaba API key and workspace ID must be configured server-side.");
    }
  }

  private baseUrl(): string {
    return SYNC_BASE_URL;
  }

  private headers(request: CartoonStillRequest): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Idempotency-Key": request.idempotencyKey,
    };
  }

  private deterministicTaskId(request: CartoonStillRequest): string {
    return `img_${createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 24)}`;
  }

  async submit(request: CartoonStillRequest): Promise<{ taskId: string }> {
    validateCartoonStillRequest(request);
    if (request.modelId !== "qwen-image-3.0-pro" || request.region !== "singapore") throw new Error("Unsupported cartoon image model or region.");
    const taskId = this.deterministicTaskId(request);
    const cached = this.cache.get(taskId);
    if (cached) return { taskId: cached.taskId };
    const body = buildAlibabaImageSubmitBody(request);
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(`${this.baseUrl()}${SYNC_PATH}`, {
        method: "POST",
        headers: this.headers(request),
        body: JSON.stringify(body),
      });
    } catch {
      throw new AlibabaSubmissionError("Alibaba image submission outcome is unknown.", "unknown", false);
    }
    const parsed = await response.json().catch(() => ({}) as Record<string, any>);
    if (!response.ok) {
      throw new AlibabaSubmissionError(
        `Alibaba image request failed (${sanitizeProviderReasonText(parsed.code || "PROVIDER_ERROR")}).`,
        response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 ? "non_billable" : "unknown",
        false,
      );
    }
    const { imageRef, taskId: resultTaskId } = parseSyncImageResult(parsed);
    // Data URIs decode in-process. An https image reference is fetched once,
    // synchronously, before the result is cached — the sync call completes
    // with bytes, never with a pending URL.
    let image: Uint8Array;
    if (imageRef.startsWith("data:")) {
      image = decodeDataUri(imageRef);
    } else if (/^https:\/\//.test(imageRef)) {
      const imageResponse = await (this.options.fetchImpl ?? fetch)(imageRef);
      if (!imageResponse.ok) throw new Error("Alibaba image result could not be fetched.");
      image = new Uint8Array(await imageResponse.arrayBuffer());
      if (!image.length) throw new Error("Alibaba image result is empty.");
    } else {
      throw new Error("Alibaba image result reference is not a usable image.");
    }
    const result = { image, taskId: resultTaskId, creditsCharged: null as number | null };
    this.cache.set(taskId, result);
    this.cache.set(resultTaskId, result);
    return { taskId: resultTaskId };
  }

  async getStatus(taskId: string): Promise<CartoonStillStatus> {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error("Alibaba image task ID is invalid.");
    if (this.cache.has(taskId)) return { state: "SUCCEEDED" };
    // Synchronous endpoint: no server-side task to poll. A task ID without a
    // cached result is an unknown outcome — never reported as success.
    throw new Error("Alibaba image task is unknown; the synchronous result was not recorded.");
  }

  async getResult(taskId: string): Promise<CartoonStillResult> {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error("Alibaba image task ID is invalid.");
    const cached = this.cache.get(taskId);
    if (!cached) throw new Error("Alibaba image task result is unavailable; resubmission is disabled.");
    return { image: new Uint8Array(cached.image), taskId: cached.taskId, creditsCharged: null };
  }

  async generate(request: CartoonStillRequest): Promise<CartoonStillResult> {
    const { taskId } = await this.submit(request);
    return this.getResult(taskId);
  }
}
