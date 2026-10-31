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
  /**
   * Cartoon video stage first frame: the exact generated still resolved to a
   * provider-fetchable signed https URL (in-flight only, never persisted).
   * Present only on the cartoon CAM-01 video submission; the sha256 binds
   * the stage to the still (videoStillSha256 === stillSha256).
   */
  firstFrame?: CartoonFirstFrame;
}

export interface GuestImageReference {
  objectPath: string;
  sha256: string;
  consentRevision: string;
  /**
   * Short-lived signed HTTPS read URL for the guest photo, resolved by the
   * worker at submission time (15-min TTL, in-flight API call only). Never
   * persisted in manifests, logs, or Firestore docs: only the server-side
   * objectPath + sha256 + consentRevision binding is stored. The provider
   * cannot fetch private GCS object paths, so a bare objectPath without this
   * URL is rejected before transport. The adapter sends this URL as the
   * wire-level `input.media` field; the sha256 stays on the request / ledger
   * path for provenance and is never submitted.
   */
  url?: string;
}

/**
 * Provider-fetchable first frame for the cartoon video stage: the exact
 * generated still bytes resolved to a short-lived signed https URL.
 * In-flight only, never persisted; the sha256 binds the video stage to the
 * still stage (videoStillSha256 must equal stillSha256).
 */
export interface CartoonFirstFrame {
  url: string;
  sha256: string;
}

export interface ProviderSubmission {
  taskId: string;
}

export interface ProviderTaskStatus {
  state: ProviderTaskState;
  errorCode?: string;
  /**
   * Sanitized provider failure reason (code detail / message text, URLs and
   * credentials redacted, truncated). Present only for FAILED tasks that
   * carried a reason; empty reasons keep the legacy generic mapping.
   */
  errorMessage?: string;
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
  "promptExtend", "input", "guestMediaId", "referenceImage", "firstFrame",
  "scenarioId", "situationId", "portraitSubmissionId", "cartoonPlan", "rehearsalOnly",
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
  if (reference.url !== undefined && (typeof reference.url !== "string" || !/^https:\/\//.test(reference.url))) {
    throw new BackendError("INVALID_ARGUMENT", "Guest image URL must be a signed https URL.");
  }
}

/**
 * Provider-bound gate: a reference image is only fetchable when the worker
 * has resolved it to a short-lived signed https URL. Bare internal bucket
 * paths (objectPath / storage_ref), http URLs, and gs:// paths are rejected
 * here so they can never reach provider transport.
 */
export function validateFetchableReferenceImage(value: unknown): asserts value is GuestImageReference {
  validateGuestImageReference(value);
  const reference = value as GuestImageReference;
  if (typeof reference.url !== "string" || !/^https:\/\//.test(reference.url)) {
    throw new BackendError("INVALID_ARGUMENT", "Guest image must resolve to a signed https URL for provider submission.");
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
  if (request.firstFrame !== undefined) validateCartoonFirstFrame(request.firstFrame);
  if (presetId === CAMEO_DEMO_PRESET.presetId) {
    if (request.referenceImage === undefined) {
      throw new BackendError("INVALID_ARGUMENT", "The cameo_demo preset requires a consent-bound reference image.");
    }
    validateFetchableReferenceImage(request.referenceImage);
    if (request.prompt !== CAMEO_DEMO_PROMPT) {
      throw new BackendError("INVALID_ARGUMENT", "Generation prompts are fixed server-side for cameo_demo.");
    }
  } else if (request.referenceImage !== undefined) {
    // Guest-bound cheap_demo jobs share the same provider-fetchability gate:
    // a resolved signed https URL is required whenever a reference is sent.
    validateFetchableReferenceImage(request.referenceImage);
  }
  if (request.firstFrame !== undefined) {
    // Cartoon video stage: the first frame must already be provider-fetchable.
    validateFetchableCartoonFirstFrame(request.firstFrame);
  }
}

/** Cartoon first-frame binding: sha256 of the exact generated still + in-flight URL. */
export function validateCartoonFirstFrame(value: unknown): asserts value is CartoonFirstFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon first frame is invalid.");
  }
  const frame = value as Record<string, unknown>;
  if (typeof frame.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(frame.sha256)) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon first-frame hash is invalid.");
  }
  if (frame.url !== undefined && !isCartoonFirstFrameUrl(frame.url)) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon first frame URL must be a data URI or signed https URL.");
  }
}

/**
 * Provider-bound gate: the still must resolve to an in-flight data URI or a
 * signed https URL before transport. Data URIs are preferred (in-process
 * bytes, no public/signed hosting); https URLs remain accepted for fixture
 * and rehearsal paths.
 */
export function validateFetchableCartoonFirstFrame(value: unknown): asserts value is CartoonFirstFrame {
  validateCartoonFirstFrame(value);
  const frame = value as CartoonFirstFrame;
  if (typeof frame.url !== "string" || !isCartoonFirstFrameUrl(frame.url)) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon first frame must resolve to a data URI or signed https URL for provider submission.");
  }
}

/** Accepts in-process data URIs (jpeg/png base64) and signed https URLs. */
function isCartoonFirstFrameUrl(value: unknown): boolean {
  return typeof value === "string" &&
    (/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(value) || /^https:\/\//.test(value));
}

/**
 * Immutable cartoon plan persisted at job creation. Scenario/situation are
 * the validated catalog pair (see selectScenarioSituation); the portrait is
 * the consent-bound submission when present. Plan IDs/versions/seeds are
 * fixed per scenario (see CARTOON_CATALOG_SCENARIOS in contracts).
 */
export interface CartoonPlan {
  scenarioId: string;
  situationId: string;
  portraitSubmissionId?: string;
  stillPlanId: string;
  videoPlanId: string;
  version: number;
  seed: number;
}

const CARTOON_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Structural validation only; catalog compatibility is enforced via selectScenarioSituation. */
export function validateCartoonPlan(value: unknown): asserts value is CartoonPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon plan must be an object.");
  }
  const plan = value as Record<string, unknown>;
  for (const field of ["scenarioId", "situationId", "stillPlanId", "videoPlanId"] as const) {
    if (typeof plan[field] !== "string" || !CARTOON_ID_RE.test(plan[field] as string)) {
      throw new BackendError("INVALID_ARGUMENT", `Cartoon plan ${field} is invalid.`);
    }
  }
  if (plan.portraitSubmissionId !== undefined &&
      (typeof plan.portraitSubmissionId !== "string" || !CARTOON_ID_RE.test(plan.portraitSubmissionId))) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon plan portraitSubmissionId is invalid.");
  }
  if (plan.version !== 1 || !Number.isSafeInteger(plan.seed)) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon plan version/seed is invalid.");
  }
}

/** Deterministic cartoon video request: cheap_demo envelope + locked-camera motion + still first frame. */
export function buildCartoonVideoRequest(
  jobId: string,
  idempotencyKey: string,
  cameraId: CameraId,
  motionPrompt: string,
  firstFrame: CartoonFirstFrame,
): VideoGenerationRequest {
  if (typeof motionPrompt !== "string" || !motionPrompt.trim() || motionPrompt.length > 4000) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon motion prompt is invalid.");
  }
  validateFetchableCartoonFirstFrame(firstFrame);
  if (cameraId !== "CAM-01") {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon video is generated only for CAM-01; other slots are fixture slots.");
  }
  return {
    jobId,
    idempotencyKey: `${idempotencyKey}:cartoon-video:${cameraId}`,
    cameraId,
    prompt: motionPrompt,
    ...CHEAP_DEMO_PRESET,
    firstFrame: { ...firstFrame },
  };
}
