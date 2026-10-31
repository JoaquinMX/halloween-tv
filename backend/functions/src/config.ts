export const REGION = "us-central1";
export const SCHEMA_VERSION = 1;
/**
 * Generation task worker memory headroom for ffmpeg normalization.
 * Linux ffmpeg plus the ~147MB packaged runtime plus frame buffers OOM at the
 * default 256MiB ("Memory limit of 256 MiB exceeded"); 1GiB gives the worker
 * explicit headroom. Referenced by runGeneration in src/index.ts and floored
 * (>= 512MiB) by tools/deploy_preflight.ts.
 */
export const GENERATION_WORKER_MEMORY = "1GiB" as const;
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

/**
 * Owner-approved STEP 2 cameo batch preset (single approved batch only).
 *
 * Separate from cheap_demo, which is never altered: 5 seconds, 480p, silent,
 * 1 output, exactly ONE provider-generated camera slot (CAM-01) plus three
 * local fixture slots, reference-image input via the validated guest binding.
 * Text-only requests are rejected for this preset; it exists solely for the
 * consented-reference batch.
 *
 * Model choice: happyhorse-1.1-r2v (reference-image-to-video). The checked-in
 * adapter performs no per-model capability validation and the repo carries no
 * offline documentation establishing that wan3.0-video accepts a
 * reference_image input at a 5-second duration, so mapping the 5s
 * reference-bound batch to the r2v (reference-to-video) model is the
 * technically safer call. Verified offline via serialization fixtures only;
 * no provider network call was made.
 *
 * Billing caveat (surfaced, never estimated): reference inputs can bill
 * input duration — the adapter surfaces the provider's realized
 * usage.input_video_duration as secondsIn, and Token Plan Credits may differ
 * from list prices. Only realized console Credits are billable truth.
 */
export const CAMEO_DEMO_PRESET = Object.freeze({
  presetId: "cameo_demo" as const,
  modelId: "happyhorse-1.1-r2v" as const,
  region: "singapore" as const,
  resolution: "480P" as const,
  secondsOut: 5 as const,
  aspectRatio: "16:9" as const,
  audio: false as const,
  outputs: 1 as const,
  autoUpscale: false as const,
});

/**
 * Fixed server-side prompt for the STEP 2 cameo batch. Baked in exactly as
 * owner-approved; never caller-supplied, never logged.
 */
export const CAMEO_DEMO_PROMPT =
  "Create a 5-second, fully 2D animated clip in the style of classic Scooby-Doo. " +
  "Use the person in V2 as the character reference, preserving his glasses, hair, beard, and outfit, all fully drawn. " +
  "In a spooky mansion hallway with crooked portraits, cobwebs, and flickering lamps, the terrified person runs left to right " +
  "while a goofy, lumbering green monster chases close behind. " +
  "Use one continuous side-tracking shot, keeping both characters visible. " +
  "0-2 seconds: The person sprints with exaggerated cartoon strides while the monster reaches toward him. " +
  "2-4 seconds: He glances backward, eyes widening, then accelerates with comically spinning legs. " +
  "4-5 seconds: Both race through an open doorway and disappear offscreen. " +
  "Bold ink outlines, flat cel shading, hand-painted purple-and-teal backgrounds, expressive faces, " +
  "elastic cartoon movement, and playful spooky slapstick. " +
  "No photorealism, 3D rendering, gore, text, or changes to the person's identity.";

/** Guest upload/consent controls. Server-side only; never trust caller-supplied paths. */
export const GUEST_CONSENT_TEXT_VERSION = "v1";
export const GUEST_CONSENT_PURPOSE = "guest_cameo";
/** Short-lived upload capability lifetime (signed PUT bound to object + content type). */
export const GUEST_UPLOAD_TTL_MS = 15 * 60 * 1000;
/** Abandoned/expired guest inputs are removed within a capped 24h deadline. */
export const GUEST_INPUT_TTL_MS = 24 * 60 * 60 * 1000;
export const GUEST_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const GUEST_ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png"] as const;
export type GuestAllowedContentType = (typeof GUEST_ALLOWED_CONTENT_TYPES)[number];
/** Exactly one provider-generated camera in a guest-bound job; the rest are local fixtures. */
export const GUEST_PROVIDER_CAMERA_ID = "CAM-01" as const;

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
