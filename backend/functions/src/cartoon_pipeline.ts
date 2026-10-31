/**
 * Two-stage cartoon pipeline (cycle-13 p2).
 *
 * Stage 1 (still): qwen-image-3.0-pro from two separately identified
 * references (subject_identity portrait + style_scene catalog bytes).
 * Stage 2 (video): wan3.0-video STANDARD cheap_demo envelope (2s/480P/
 * silent/no-watermark/prompt_extend false, locked camera) animating the
 * exact generated still as first_frame on CAM-01; CAM-02..04 are local
 * fixture slots (never billable).
 *
 * Programs against p1 (selectScenarioSituation, readScenarioReferenceBytes)
 * and p3 (canGenerateFromPortrait) without duplicating their logic.
 */
import { createHash } from "node:crypto";
import { BackendError } from "./contracts";
import { CartoonStillRequest, ImageGenerationPort, validateCartoonStillRequest } from "./image_generation_port";
import { composeCartoonPromptsFromPair } from "./cartoon_prompts";
import { getScenario, getSituation, readScenarioReferenceBytes, ScenarioCatalogFile, SituationsFile } from "./scenario_catalog";
import { canGenerateFromPortrait, ProvenanceRecord } from "./consent_provenance";

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

/** Builds the cartoon motion prompt from the same validated pair (locked camera). */
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
