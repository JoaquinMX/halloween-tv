export const REGION = "us-central1";
export const SCHEMA_VERSION = 1;
export const DELIVERY_URL_TTL_SECONDS = 15 * 60;
export const MEDIA_RETENTION_MS = 24 * 60 * 60 * 1000;
export const REQUIRED_CAMERA_IDS = ["CAM-01", "CAM-02", "CAM-03", "CAM-04"] as const;

/** Generation is inert unless an operator explicitly opts in. */
export function isGenerationEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.GENERATION_ENABLED === "true";
}

export const CHEAP_DEMO_PRESET = Object.freeze({
  presetId: "cheap_demo" as const,
  modelId: "wan3.0-video" as const,
  region: "singapore" as const,
  resolution: "480P" as const,
  secondsOut: 2 as const,
  aspectRatio: "16:9" as const,
  audio: false as const,
  outputs: 1 as const,
  autoUpscale: false as const,
});

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "MANIFEST_MISMATCH",
  "CLIP_EXPIRED",
  "PROVIDER_UNAVAILABLE",
  "BUDGET_EXCEEDED",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const JOB_STATES = ["queued", "running", "ready", "delivering", "purged", "failed", "expired"] as const;
export type JobState = (typeof JOB_STATES)[number];
