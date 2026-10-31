/**
 * Two-stage cartoon pipeline (cycle-13 p2, cycle-13 fix-3).
 *
 * Stage 1 (still): qwen-image-3.0-pro synchronous multimodal generation from
 * two separately identified references (subject_identity portrait +
 * style_scene catalog bytes) as in-process data URIs.
 * Stage 2 (video): wan3.0-video STANDARD cheap_demo envelope (2s/480P/
 * silent/no-watermark/prompt_extend false) animating the exact generated
 * still as first_frame on CAM-01; CAM-02..04 are local fixture slots (never
 * billable).
 *
 * Programs against p1 (selectScenarioSituation, readScenarioReferenceBytes)
 * and p3 (canGenerateFromPortrait) without duplicating their logic.
 *
 * Provenance (doc comment only; no private bytes or data URIs are committed
 * here): subject-first / scene-and-style-last ordering follows the neutral
 * Androidify adaptation pattern — android/androidify @
 * a4be10f78b7b84b4cc8907e1e7da307aab6c373c,
 * setup/remote_config_defaults.json (parameters.prompt_image_description /
 * parameters.prompt_image_description.prompt_image_generation_skin_tone /
 * parameters.bot_background_instruction_prompt (.defaultValue.value)),
 * core/network/src/main/java/com/android/developers/androidify/RemoteConfigDataSource.kt.
 */
import { createHash } from "node:crypto";
import { BackendError, CARTOON_CATALOG_SCENARIOS } from "./contracts";
import { CartoonStillRequest, ImageGenerationPort, validateCartoonStillRequest } from "./image_generation_port";
import { composeCartoonPromptsFromPair } from "./cartoon_prompts";
import { getScenario, getSituation, readScenarioReferenceBytes, ScenarioCatalogFile, SituationsFile } from "./scenario_catalog";
import { canGenerateFromPortrait, ProvenanceRecord } from "./consent_provenance";
import { CartoonPlan } from "./video_generation_port";

export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

export interface CartoonPlanInputs {
  scenarioId: string;
  situationId: string;
  portraitSubmissionId?: string;
  stillPlanId: string;
  videoPlanId: string;
  version: number;
  seed: number;
}

/** Deterministic still idempotency key: the immutable plan, never a timestamp. */
export function cartoonStillIdempotencyKey(jobId: string, scenarioId: string, situationId: string): string {
  return `${jobId}:still:${scenarioId}:${situationId}`;
}

/** Deterministic still object path for the hashed consent-bound still. */
export function cartoonStillObjectPath(partyId: string, jobId: string): string {
  return `parties/${partyId}/cartoonStills/${jobId}/still.png`;
}

/** Validates the ordered, role-distinct references immediately before transport. */
export async function generateCartoonStill(port: ImageGenerationPort, request: CartoonStillRequest) {
  validateCartoonStillRequest(request);
  const [identity, scene] = request.references;
  if (identity.role !== "subject_identity" || scene.role !== "style_scene" || identity === scene) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon references must be separate subject_identity and style_scene inputs.");
  }
  for (const reference of request.references) {
    if (!reference.bytes.length || sha256(reference.bytes) !== reference.sha256) {
      throw new BackendError("INVALID_ARGUMENT", "Cartoon reference bytes do not match their recorded digest.");
    }
  }
  const result = await port.generate(request);
  if (!result.image.length) throw new BackendError("PROVIDER_UNAVAILABLE", "Cartoon image provider returned an empty still.");
  return { ...result, sha256: sha256(result.image) };
}

/**
 * Builds the deterministic still request from a validated catalog pair plus
 * caller-supplied portrait bytes. Portrait consent is gated via p3
 * (canGenerateFromPortrait) when a provenance record is supplied; catalog
 * pair compatibility is gated via p1 (compose path calls
 * selectScenarioSituation internally).
 */
export function buildCartoonStillRequest(input: {
  jobId: string;
  scenarioId: string;
  situationId: string;
  catalog: ScenarioCatalogFile;
  situations: SituationsFile;
  portraitBytes: Uint8Array;
  portraitContentType: "image/jpeg" | "image/png";
  portraitSha256: string;
  functionsRoot: string;
  provenance?: ProvenanceRecord;
  provenanceScope?: { partyId: string; channelId?: string; deviceId?: string; nowMs: number };
}): CartoonStillRequest {
  const scenario = getScenario(input.catalog, input.scenarioId);
  const situation = getSituation(input.situations, input.situationId);
  if (input.provenance !== undefined && input.provenanceScope !== undefined) {
    if (!canGenerateFromPortrait(input.provenance, input.provenanceScope)) {
      throw new BackendError("FORBIDDEN", "Portrait-derived generation is not consented for this scope.");
    }
    if (input.provenance.sourceHash !== undefined && input.provenance.sourceHash !== input.portraitSha256) {
      throw new BackendError("MANIFEST_MISMATCH", "Portrait bytes do not match the consented source hash.");
    }
  }
  if (sha256(input.portraitBytes) !== input.portraitSha256) {
    throw new BackendError("INVALID_ARGUMENT", "Portrait bytes do not match their recorded digest.");
  }
  const sceneBytes = Buffer.from(readScenarioReferenceBytes(scenario, input.functionsRoot));
  const prompts = composeCartoonPromptsFromPair(scenario, situation);
  const request: CartoonStillRequest = {
    jobId: input.jobId,
    idempotencyKey: cartoonStillIdempotencyKey(input.jobId, scenario.id, situation.id),
    prompt: prompts.still,
    negativePrompt: prompts.negative,
    modelId: "qwen-image-3.0-pro",
    region: "singapore",
    references: [
      { role: "subject_identity", bytes: input.portraitBytes, sha256: input.portraitSha256, contentType: input.portraitContentType },
      { role: "style_scene", bytes: new Uint8Array(sceneBytes), sha256: scenario.sha256, contentType: "image/jpeg" },
    ],
  };
  validateCartoonStillRequest(request);
  return request;
}

/** Builds the cartoon motion prompt from the same validated pair (the situation's own motion + camera language, verbatim). */
export function buildCartoonMotionPrompt(input: {
  scenarioId: string;
  situationId: string;
  catalog: ScenarioCatalogFile;
  situations: SituationsFile;
}): string {
  const scenario = getScenario(input.catalog, input.scenarioId);
  const situation = getSituation(input.situations, input.situationId);
  return composeCartoonPromptsFromPair(scenario, situation).motion;
}

/** Deterministic 32-bit selector from a server seed string (FNV-1a). */
function selector32(seed: string, salt: string): number {
  let hash = 0x811c9dc5;
  const input = `${salt}\n${seed}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Server-side catalog auto-select (cycle-13 fix-3): randomly selects a
 * catalog scenario + compatible situation at job setup from a seeded RNG.
 * The seed is stable per portrait (the consented submission id), so retries
 * and replays reuse the same pair and never reroll: the same submission
 * always maps to the same scenario/situation, and the fixed slot
 * (stillPlanId/videoPlanId/version/seed) for the chosen scenario is
 * persisted immutably in the cartoon plan at creation. The client never
 * supplies any of these fields.
 */
export function buildAutoCartoonPlan(input: {
  submissionId: string;
  catalog: ScenarioCatalogFile;
  situations: SituationsFile;
}): CartoonPlan {
  if (typeof input.submissionId !== "string" || !input.submissionId) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon auto-select requires a portrait submission id.");
  }
  const records = input.catalog.records;
  if (!Array.isArray(records) || records.length === 0) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon auto-select requires a non-empty scenario catalog.");
  }
  const scenarioIndex = selector32(input.submissionId, "scenario") % records.length;
  const scenario = records[scenarioIndex];
  if (!scenario || !Array.isArray(scenario.compatibleSituations) || scenario.compatibleSituations.length === 0) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon auto-select found a scenario with no compatible situation.");
  }
  const compatible = scenario.compatibleSituations.filter((id) =>
    input.situations.events.some((event) => event.id === id),
  );
  if (!compatible.length) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon auto-select found no resolvable compatible situation.");
  }
  const situationId = compatible[selector32(input.submissionId, `situation:${scenario.id}`) % compatible.length];
  // Fixed slot for the chosen scenario: the planner slot index follows the
  // catalog record order, so plan IDs/versions/seeds stay pinned per
  // scenario exactly as the batch planner emits them.
  const slot = CARTOON_CATALOG_SCENARIOS[scenarioIndex % CARTOON_CATALOG_SCENARIOS.length];
  return {
    scenarioId: scenario.id,
    situationId,
    portraitSubmissionId: input.submissionId,
    stillPlanId: slot.stillPlanId,
    videoPlanId: slot.videoPlanId,
    version: slot.version,
    seed: slot.seed,
  };
}
