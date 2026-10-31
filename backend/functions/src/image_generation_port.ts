import { BackendError } from "./contracts";

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
export interface CartoonStillStatus { state: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED"; errorCode?: string; errorMessage?: string }
export interface ImageGenerationPort {
  generate(request: CartoonStillRequest): Promise<CartoonStillResult>;
  submit?(request: CartoonStillRequest): Promise<{ taskId: string }>;
  getStatus?(taskId: string): Promise<CartoonStillStatus>;
  getResult?(taskId: string): Promise<CartoonStillResult>;
}

const HEX_RE = /^[a-f0-9]{64}$/;

/** Structural + ordering validation for the two-stage still request. */
export function validateCartoonStillRequest(value: unknown): asserts value is CartoonStillRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon still request must be an object.");
  }
  const request = value as Record<string, unknown>;
  if (typeof request.jobId !== "string" || !request.jobId) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon still jobId is required.");
  }
  if (typeof request.idempotencyKey !== "string" || !request.idempotencyKey) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon still idempotencyKey is required.");
  }
  if (typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 4000) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon still prompt is invalid.");
  }
  if (typeof request.negativePrompt !== "string" || !request.negativePrompt.trim()) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon still negative prompt is required.");
  }
  if (request.modelId !== "qwen-image-3.0-pro" || request.region !== "singapore") {
    throw new BackendError("INVALID_ARGUMENT", "Unsupported cartoon image model or region.");
  }
  const references = request.references as unknown;
  if (!Array.isArray(references) || references.length !== 2) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon still requires exactly two references.");
  }
  const [identity, scene] = references as Array<Record<string, unknown>>;
  if (identity.role !== "subject_identity" || scene.role !== "style_scene") {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon references must be ordered subject_identity then style_scene.");
  }
  if (identity === scene) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon references must be separate inputs.");
  }
  for (const reference of references as CartoonImageReference[]) {
    if (!(reference.bytes instanceof Uint8Array) || reference.bytes.byteLength === 0) {
      throw new BackendError("INVALID_ARGUMENT", "Cartoon reference bytes are missing.");
    }
    if (typeof reference.sha256 !== "string" || !HEX_RE.test(reference.sha256)) {
      throw new BackendError("INVALID_ARGUMENT", "Cartoon reference digest is invalid.");
    }
    if (reference.contentType !== "image/jpeg" && reference.contentType !== "image/png") {
      throw new BackendError("INVALID_ARGUMENT", "Cartoon reference content type is unsupported.");
    }
  }
}
