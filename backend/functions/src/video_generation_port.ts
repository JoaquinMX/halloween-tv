import { BackendError } from "./contracts";
import { CHEAP_DEMO_PRESET, REQUIRED_CAMERA_IDS } from "./config";

export type CameraId = (typeof REQUIRED_CAMERA_IDS)[number];
export type ProviderTaskState = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

export interface VideoGenerationRequest {
  jobId: string;
  idempotencyKey: string;
  cameraId: CameraId;
  prompt: string;
  modelId: typeof CHEAP_DEMO_PRESET.modelId;
  presetId: typeof CHEAP_DEMO_PRESET.presetId;
  region: typeof CHEAP_DEMO_PRESET.region;
  resolution: typeof CHEAP_DEMO_PRESET.resolution;
  secondsOut: typeof CHEAP_DEMO_PRESET.secondsOut;
  aspectRatio: typeof CHEAP_DEMO_PRESET.aspectRatio;
  audio: typeof CHEAP_DEMO_PRESET.audio;
  outputs: typeof CHEAP_DEMO_PRESET.outputs;
  autoUpscale: typeof CHEAP_DEMO_PRESET.autoUpscale;
}

export interface ProviderSubmission {
  taskId: string;
}

export interface ProviderTaskStatus {
  state: ProviderTaskState;
  errorCode?: string;
}

export interface ProviderResult {
  /** A provider URL or an offline fixture path. URLs are fetched only after task success. */
  video: { kind: "url" | "file"; value: string };
  secondsOut: number;
  secondsIn: number;
  creditsCharged: number | null;
}

export interface VideoGenerationPort {
  submit(request: VideoGenerationRequest): Promise<ProviderSubmission>;
  getStatus(taskId: string): Promise<ProviderTaskStatus>;
  getResult(taskId: string): Promise<ProviderResult>;
}

const CONTROL_FIELDS = [
  "modelId", "presetId", "region", "resolution", "secondsOut", "aspectRatio",
  "audio", "outputs", "autoUpscale",
] as const;
const ALLOWED_GENERATION_FIELDS = new Set([
  "partyId", "deviceId", "channelId", "jobId", "idempotencyKey", "presetId", "modelId", "region",
  "resolution", "secondsOut", "aspectRatio", "audio", "outputs", "autoUpscale", "prompt", "cameraId",
  "promptExtend", "input",
]);

/** Rejects unsupported generation controls before a provider request can be formed. */
export function validateCheapDemoControls(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackendError("INVALID_ARGUMENT", "Generation controls must be an object.");
  }
  const controls = value as Record<string, unknown>;
  const unsupported = Object.keys(controls).find((field) => !ALLOWED_GENERATION_FIELDS.has(field));
  if (unsupported) throw new BackendError("INVALID_ARGUMENT", `Unsupported generation field: ${unsupported}.`);
  for (const field of CONTROL_FIELDS) {
    if (field in controls && controls[field] !== CHEAP_DEMO_PRESET[field]) {
      throw new BackendError("INVALID_ARGUMENT", `Unsupported ${field}; only the cheap_demo preset is allowed.`);
    }
  }
  if ("promptExtend" in controls && controls.promptExtend !== false) {
    throw new BackendError("INVALID_ARGUMENT", "Prompt extension is disabled for cheap_demo.");
  }
  if ("input" in controls && controls.input !== "text") {
    throw new BackendError("INVALID_ARGUMENT", "Only text-only generation input is supported.");
  }
}

export function buildCheapDemoRequest(
  jobId: string,
  idempotencyKey: string,
  cameraId: CameraId,
): VideoGenerationRequest {
  return {
    jobId,
    idempotencyKey: `${idempotencyKey}:${cameraId}`,
    cameraId,
    prompt: `A two-second, silent 16:9 Halloween security-camera scene for ${cameraId}.`,
    ...CHEAP_DEMO_PRESET,
  };
}

export function validateVideoGenerationRequest(value: unknown): asserts value is VideoGenerationRequest {
  validateCheapDemoControls(value);
  const request = value as Partial<VideoGenerationRequest>;
  if (typeof request.jobId !== "string" || !request.jobId ||
      typeof request.idempotencyKey !== "string" || !request.idempotencyKey ||
      !REQUIRED_CAMERA_IDS.includes(request.cameraId as CameraId) ||
      typeof request.prompt !== "string" || request.prompt.trim().length === 0) {
    throw new BackendError("INVALID_ARGUMENT", "A job, idempotency key, camera, and text prompt are required.");
  }
  for (const field of CONTROL_FIELDS) {
    if (request[field] !== CHEAP_DEMO_PRESET[field]) {
      throw new BackendError("INVALID_ARGUMENT", `Unsupported ${field}; only the cheap_demo preset is allowed.`);
    }
  }
}
