import { BackendError } from "./contracts";
import { CAMEO_DEMO_PRESET, CAMEO_DEMO_PROMPT, CHEAP_DEMO_PRESET, REQUIRED_CAMERA_IDS } from "./config";

export type CameraId = (typeof REQUIRED_CAMERA_IDS)[number];
export type ProviderTaskState = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

/** Server-locked generation presets. cheap_demo is never altered; cameo_demo is the separate STEP 2 batch preset. */
export type PresetId = typeof CHEAP_DEMO_PRESET.presetId | typeof CAMEO_DEMO_PRESET.presetId;

export interface VideoGenerationRequest {
  jobId: string;
  idempotencyKey: string;
  cameraId: CameraId;
  prompt: string;
  modelId: typeof CHEAP_DEMO_PRESET.modelId | typeof CAMEO_DEMO_PRESET.modelId;
  presetId: PresetId;
  region: typeof CHEAP_DEMO_PRESET.region;
  resolution: typeof CHEAP_DEMO_PRESET.resolution;
  secondsOut: typeof CHEAP_DEMO_PRESET.secondsOut | typeof CAMEO_DEMO_PRESET.secondsOut;
  aspectRatio: typeof CHEAP_DEMO_PRESET.aspectRatio;
  audio: typeof CHEAP_DEMO_PRESET.audio;
  outputs: typeof CHEAP_DEMO_PRESET.outputs;
  autoUpscale: typeof CHEAP_DEMO_PRESET.autoUpscale;
  /** Validated consent-bound guest photo binding. Never changes cheap_demo controls. */
  referenceImage?: GuestImageReference;
}

export interface GuestImageReference {
  objectPath: string;
  sha256: string;
  consentRevision: string;
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
  "promptExtend", "input", "guestMediaId", "referenceImage",
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

/**
 * Locks the STEP 2 cameo batch to its own server preset. cheap_demo controls
 * are untouched; this is a separate lock for a separate preset object.
 */
export function validateCameoDemoControls(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackendError("INVALID_ARGUMENT", "Generation controls must be an object.");
  }
  const controls = value as Record<string, unknown>;
  const unsupported = Object.keys(controls).find((field) => !ALLOWED_GENERATION_FIELDS.has(field));
  if (unsupported) throw new BackendError("INVALID_ARGUMENT", `Unsupported generation field: ${unsupported}.`);
  for (const field of CONTROL_FIELDS) {
    if (field in controls && controls[field] !== CAMEO_DEMO_PRESET[field]) {
      throw new BackendError("INVALID_ARGUMENT", `Unsupported ${field}; only the cameo_demo preset is allowed.`);
    }
  }
  if ("promptExtend" in controls && controls.promptExtend !== false) {
    throw new BackendError("INVALID_ARGUMENT", "Prompt extension is disabled for cameo_demo.");
  }
  if ("input" in controls && controls.input !== undefined) {
    throw new BackendError("INVALID_ARGUMENT", "Only reference-image generation input is supported for cameo_demo.");
  }
}

/**
 * Preset dispatcher: cameo_demo validates against its own lock, everything
 * else keeps the cheap_demo lock byte-for-byte.
 */
export function validatePresetControls(value: unknown): void {
  const preset = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).presetId ?? "cheap_demo"
    : "cheap_demo";
  if (preset === CAMEO_DEMO_PRESET.presetId) {
    validateCameoDemoControls(value);
    return;
  }
  validateCheapDemoControls(value);
}

export function buildCheapDemoRequest(
  jobId: string,
  idempotencyKey: string,
  cameraId: CameraId,
  referenceImage?: GuestImageReference,
): VideoGenerationRequest {
  const request: VideoGenerationRequest = {
    jobId,
    idempotencyKey: `${idempotencyKey}:${cameraId}`,
    cameraId,
    prompt: `A two-second, silent 16:9 Halloween security-camera scene for ${cameraId}.`,
    ...CHEAP_DEMO_PRESET,
  };
  if (referenceImage !== undefined) {
    validateGuestImageReference(referenceImage);
    request.referenceImage = { ...referenceImage };
  }
  return request;
}

/**
 * Fixed server-side request for the STEP 2 cameo batch. The approved prompt
 * is baked in as a server constant (never caller-supplied, never logged);
 * the consent-bound reference image is required — text-only requests for
 * this preset are rejected.
 */
export function buildCameoDemoRequest(
  jobId: string,
  idempotencyKey: string,
  cameraId: CameraId,
  referenceImage: GuestImageReference | undefined,
): VideoGenerationRequest {
  if (referenceImage === undefined) {
    throw new BackendError("INVALID_ARGUMENT", "The cameo_demo preset requires a consent-bound reference image.");
  }
  validateGuestImageReference(referenceImage);
  return {
    jobId,
    idempotencyKey: `${idempotencyKey}:${cameraId}`,
    cameraId,
    prompt: CAMEO_DEMO_PROMPT,
    ...CAMEO_DEMO_PRESET,
    referenceImage: { ...referenceImage },
  };
}

/** Validated image binding: server-side object path, bytes hash, and consent revision. */
export function validateGuestImageReference(value: unknown): asserts value is GuestImageReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackendError("INVALID_ARGUMENT", "Guest image reference is invalid.");
  }
  const reference = value as Record<string, unknown>;
  if (typeof reference.objectPath !== "string" ||
      !/^parties\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/guests\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/ingest\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/photo\.jpg$/.test(reference.objectPath)) {
    throw new BackendError("INVALID_ARGUMENT", "Guest image object path is invalid.");
  }
  if (typeof reference.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256)) {
    throw new BackendError("INVALID_ARGUMENT", "Guest image hash is invalid.");
  }
  if (typeof reference.consentRevision !== "string" || !reference.consentRevision) {
    throw new BackendError("INVALID_ARGUMENT", "Guest image consent revision is required.");
  }
}

export function validateVideoGenerationRequest(value: unknown): asserts value is VideoGenerationRequest {
  const presetId = (value as Partial<VideoGenerationRequest> | undefined)?.presetId;
  const expected = presetId === CAMEO_DEMO_PRESET.presetId ? CAMEO_DEMO_PRESET : CHEAP_DEMO_PRESET;
  const lockName = presetId === CAMEO_DEMO_PRESET.presetId ? "cameo_demo" : "cheap_demo";
  if (presetId === CAMEO_DEMO_PRESET.presetId) {
    validateCameoDemoControls(value);
  } else {
    validateCheapDemoControls(value);
  }
  const request = value as Partial<VideoGenerationRequest>;
  if (typeof request.jobId !== "string" || !request.jobId ||
      typeof request.idempotencyKey !== "string" || !request.idempotencyKey ||
      !REQUIRED_CAMERA_IDS.includes(request.cameraId as CameraId) ||
      typeof request.prompt !== "string" || request.prompt.trim().length === 0) {
    throw new BackendError("INVALID_ARGUMENT", "A job, idempotency key, camera, and text prompt are required.");
  }
  for (const field of CONTROL_FIELDS) {
    if (request[field] !== expected[field]) {
      throw new BackendError("INVALID_ARGUMENT", `Unsupported ${field}; only the ${lockName} preset is allowed.`);
    }
  }
  if (request.referenceImage !== undefined) validateGuestImageReference(request.referenceImage);
  if (presetId === CAMEO_DEMO_PRESET.presetId) {
    if (request.referenceImage === undefined) {
      throw new BackendError("INVALID_ARGUMENT", "The cameo_demo preset requires a consent-bound reference image.");
    }
    if (request.prompt !== CAMEO_DEMO_PROMPT) {
      throw new BackendError("INVALID_ARGUMENT", "Generation prompts are fixed server-side for cameo_demo.");
    }
  }
}
