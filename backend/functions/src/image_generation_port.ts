export interface CartoonImageReference {
  role: "subject_identity" | "style_scene";
  bytes: Uint8Array;
  sha256: string;
  contentType: "image/jpeg" | "image/png";
}
export interface CartoonStillRequest {
  jobId: string; idempotencyKey: string; prompt: string; negativePrompt: string;
  modelId: "qwen-image-3.0-pro"; region: "singapore";
  references: [CartoonImageReference, CartoonImageReference];
}
export interface CartoonStillResult { image: Uint8Array; taskId: string; creditsCharged: number | null }
export interface ImageGenerationPort { generate(request: CartoonStillRequest): Promise<CartoonStillResult> }
