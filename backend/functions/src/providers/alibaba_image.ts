import { AlibabaSubmissionError, sanitizeProviderReasonText } from "./alibaba";
import { CartoonStillRequest, CartoonStillResult, ImageGenerationPort } from "../image_generation_port";
import { sha256 } from "../cartoon_pipeline";

const ENDPOINT = "/api/v1/services/aigc/multimodal-generation/generation";
export type ImageUrlResolver = (bytes: Uint8Array, contentType: string, digest: string) => Promise<string>;

/**
 * qwen-image-3.0-pro adapter. Mapping is deterministic: references are ordered
 * subject_identity then style_scene and serialized to input.images as URL
 * strings; the role ordering is also stated in the prompt because this wire
 * API accepts image URLs but has no role-tagged image object schema.
 */
export class AlibabaImageGenerationPort implements ImageGenerationPort {
  constructor(private readonly options: { apiKey: string; workspaceId: string; resolveImageUrl: ImageUrlResolver; fetchImpl?: typeof fetch }) {}
  async generate(request: CartoonStillRequest): Promise<CartoonStillResult> {
    if (request.modelId !== "qwen-image-3.0-pro" || request.region !== "singapore") throw new Error("Unsupported cartoon image model or region.");
    const [subject, style] = request.references;
    for (const ref of request.references) if (sha256(ref.bytes) !== ref.sha256) throw new Error("Cartoon reference digest mismatch.");
    const urls = await Promise.all([subject, style].map(async ref => {
      const url = await this.options.resolveImageUrl(ref.bytes, ref.contentType, ref.sha256);
      if (!/^https:\/\//.test(url)) throw new Error("Image reference resolver must return a provider-fetchable HTTPS URL.");
      return url;
    }));
    const host = `https://${this.options.workspaceId}.ap-southeast-1.maas.aliyuncs.com`;
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(`${host}${ENDPOINT}`, { method: "POST", headers: {
        Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json", "X-DashScope-Async": "enable",
        "X-DashScope-Idempotency-Key": request.idempotencyKey,
      }, body: JSON.stringify({ model: request.modelId, input: { prompt: `${request.prompt}\nReference order: first subject_identity, second style_scene.`, images: urls }, parameters: { negative_prompt: request.negativePrompt } }) });
    } catch { throw new AlibabaSubmissionError("Alibaba image submission outcome is unknown.", "unknown", false); }
    const body = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) throw new AlibabaSubmissionError(`Alibaba image request failed (${sanitizeProviderReasonText(body.code || "PROVIDER_ERROR")}).`, response.status >= 400 && response.status < 500 ? "non_billable" : "unknown", false);
    const output = body.output ?? {};
    const taskId = output.task_id ?? body.task_id;
    if (typeof taskId !== "string") throw new AlibabaSubmissionError("Alibaba image task identity is missing.", "unknown", false);
    const resultUrl = output.results?.[0]?.url ?? output.image_url;
    if (typeof resultUrl !== "string" || !/^https:\/\//.test(resultUrl)) throw new Error("Alibaba image result URL is unavailable; task polling is required.");
    const imageResponse = await (this.options.fetchImpl ?? fetch)(resultUrl);
    if (!imageResponse.ok) throw new Error("Alibaba image result could not be fetched.");
    return { image: new Uint8Array(await imageResponse.arrayBuffer()), taskId, creditsCharged: null };
  }
}
