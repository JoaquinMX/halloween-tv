import { AlibabaSubmissionError, sanitizeProviderReasonText } from "./alibaba";
import { CartoonStillRequest, CartoonStillResult, CartoonStillStatus, ImageGenerationPort, validateCartoonStillRequest } from "../image_generation_port";
import { sha256 } from "../cartoon_pipeline";

const ENDPOINT = "/api/v1/services/aigc/multimodal-generation/generation";
const TASKS_PREFIX = "/api/v1/tasks/";
export type ImageUrlResolver = (bytes: Uint8Array, contentType: string, digest: string) => Promise<string>;

function record(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

/**
 * Pure request serialization: deterministic wire mapping for the still stage.
 * References are ordered subject_identity then style_scene and serialized to
 * input.images as URL strings; the role ordering is also stated in the
 * prompt because this wire API accepts image URLs but has no role-tagged
 * image object schema. Negative prompt rides as parameters.negative_prompt.
 * Zero network.
 */
export function buildAlibabaImageSubmitBody(
  request: CartoonStillRequest,
  imageUrls: [string, string],
): { model: string; input: Record<string, unknown>; parameters: Record<string, unknown> } {
  validateCartoonStillRequest(request);
  const [subjectUrl, styleUrl] = imageUrls;
  for (const url of imageUrls) {
    if (typeof url !== "string" || !/^https:\/\//.test(url)) {
      throw new Error("Image reference resolver must return a provider-fetchable HTTPS URL.");
    }
  }
  return {
    model: request.modelId,
    input: {
      prompt: `${request.prompt}\nReference order: first subject_identity, second style_scene.`,
      images: [subjectUrl, styleUrl],
    },
    parameters: { negative_prompt: request.negativePrompt },
  };
}

function parseImageStatus(value: unknown): CartoonStillStatus {
  const root = record(value);
  const output = record(root?.output);
  const rawState = output?.task_status ?? root?.task_status;
  if (rawState === "PENDING") return { state: "PENDING" };
  if (rawState === "RUNNING") return { state: "RUNNING" };
  if (rawState === "SUCCEEDED") return { state: "SUCCEEDED" };
  if (rawState === "FAILED" || rawState === "CANCELED" || rawState === "CANCELLED") {
    const source = output?.code !== undefined || output?.message !== undefined ? output : root;
    const message = sanitizeProviderReasonText(typeof source?.message === "string" ? source.message : source?.reason);
    const status: CartoonStillStatus = { state: "FAILED", errorCode: String(source?.code ?? "PROVIDER_ERROR").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) };
    if (message) status.errorMessage = message;
    return status;
  }
  throw new Error("Alibaba image task returned an unrecognized state.");
}

/**
 * qwen-image-3.0-pro adapter (Alibaba Singapore, Token Plan only).
 * Mapping is deterministic: references are ordered subject_identity then
 * style_scene and serialized to input.images as URL strings; the role
 * ordering is also stated in the prompt because this wire API accepts image
 * URLs but has no role-tagged image object schema.
 */
export class AlibabaImageGenerationPort implements ImageGenerationPort {
  constructor(private readonly options: { apiKey: string; workspaceId: string; resolveImageUrl: ImageUrlResolver; fetchImpl?: typeof fetch }) {}

  private baseUrl(): string {
    return `https://${this.options.workspaceId}.ap-southeast-1.maas.aliyuncs.com`;
  }

  async submit(request: CartoonStillRequest): Promise<{ taskId: string }> {
    validateCartoonStillRequest(request);
    if (request.modelId !== "qwen-image-3.0-pro" || request.region !== "singapore") throw new Error("Unsupported cartoon image model or region.");
    const [subject, style] = request.references;
    for (const ref of request.references) if (sha256(ref.bytes) !== ref.sha256) throw new Error("Cartoon reference digest mismatch.");
    const urls = await Promise.all([subject, style].map(async (ref) => {
      const url = await this.options.resolveImageUrl(ref.bytes, ref.contentType, ref.sha256);
      if (!/^https:\/\//.test(url)) throw new Error("Image reference resolver must return a provider-fetchable HTTPS URL.");
      return url;
    }));
    const body = buildAlibabaImageSubmitBody(request, urls as [string, string]);
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(`${this.baseUrl()}${ENDPOINT}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json", "X-DashScope-Async": "enable",
          "X-DashScope-Idempotency-Key": request.idempotencyKey,
        },
        body: JSON.stringify(body),
      });
    } catch { throw new AlibabaSubmissionError("Alibaba image submission outcome is unknown.", "unknown", false); }
    const parsed = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) {
      throw new AlibabaSubmissionError(
        `Alibaba image request failed (${sanitizeProviderReasonText(parsed.code || "PROVIDER_ERROR")}).`,
        response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 ? "non_billable" : "unknown",
        false,
      );
    }
    const output = parsed.output ?? {};
    const taskId = output.task_id ?? parsed.task_id;
    if (typeof taskId !== "string" || !taskId) throw new AlibabaSubmissionError("Alibaba image task identity is missing.", "unknown", false);
    return { taskId };
  }

  async getStatus(taskId: string): Promise<CartoonStillStatus> {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error("Alibaba image task ID is invalid.");
    const response = await (this.options.fetchImpl ?? fetch)(`${this.baseUrl()}${TASKS_PREFIX}${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
    });
    if (!response.ok) throw new Error(`Alibaba image status request failed (${response.status}).`);
    return parseImageStatus(await response.json());
  }

  async getResult(taskId: string): Promise<CartoonStillResult> {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error("Alibaba image task ID is invalid.");
    const response = await (this.options.fetchImpl ?? fetch)(`${this.baseUrl()}${TASKS_PREFIX}${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
    });
    if (!response.ok) throw new Error(`Alibaba image result request failed (${response.status}).`);
    const body = await response.json() as Record<string, any>;
    const output = body.output ?? {};
    const resultUrl = output.results?.[0]?.url ?? output.image_url;
    if (typeof resultUrl !== "string" || !/^https:\/\//.test(resultUrl)) {
      throw new Error("Alibaba image result URL is unavailable; task polling is required.");
    }
    const imageResponse = await (this.options.fetchImpl ?? fetch)(resultUrl);
    if (!imageResponse.ok) throw new Error("Alibaba image result could not be fetched.");
    const bytes = new Uint8Array(await imageResponse.arrayBuffer());
    if (!bytes.length) throw new Error("Alibaba image result is empty.");
    return { image: bytes, taskId, creditsCharged: null };
  }

  async generate(request: CartoonStillRequest): Promise<CartoonStillResult> {
    const { taskId } = await this.submit(request);
    const startedAt = Date.now();
    const deadlineMs = 10 * 60 * 1000;
    for (;;) {
      const status = await this.getStatus(taskId);
      if (status.state === "SUCCEEDED") return this.getResult(taskId);
      if (status.state === "FAILED") {
        throw new AlibabaSubmissionError(`Alibaba image task failed (${status.errorCode ?? "PROVIDER_ERROR"}).`, "unknown", false);
      }
      if (Date.now() - startedAt >= deadlineMs) throw new Error("Alibaba image task polling timed out; task ID is retained for reconciliation.");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
