/**
 * Server-owned, two-stage cartoon prompt composition (cycle-13 p2, cycle-13 fix-3).
 *
 * Programs against the p1 catalog (scenario_catalog.ts) and never duplicates
 * its validation: callers pass validated ScenarioRecord/SituationEvent pairs
 * (via selectScenarioSituation), and this module only orders their text into
 * the fixed identity-first / static-pose-then-scene envelope for the still
 * and the motion-faithful envelope for the video.
 *
 * Provenance (doc comment only; no private bytes or data URIs are committed
 * here): the subject-first / dominant-foreground / scene-and-style-last
 * ordering follows the neutral Androidify adaptation pattern —
 * android/androidify @ a4be10f78b7b84b4cc8907e1e7da307aab6c373c, with the
 * prompt-shaping parameters
 * setup/remote_config_defaults.json
 * (parameters.prompt_image_description /
 * parameters.prompt_image_description.prompt_image_generation_skin_tone /
 * parameters.bot_background_instruction_prompt (.defaultValue.value)) and
 * core/network/src/main/java/com/android/developers/androidify/RemoteConfigDataSource.kt.
 * NEUTRAL means: describe the ACTUAL consenting subject's distinctive
 * attributes from the photo binding through one generic preservation
 * instruction (glasses, facial hair, hairstyle, outfit as seen in the
 * subject_identity reference). No one person's attributes are ever
 * hard-coded into the shared composer; caller strings that hard-code a
 * specific person's appearance are rejected below.
 *
 * Fix-3 contradictions resolved:
 * - STILL prompt carries ONE unambiguous STATIC starting pose, no motion
 *   language (the timed action choreography belongs to the video stage
 *   only), and never says "no people": catalog "no people" fragments are
 *   rewritten to "empty of pre-existing characters" plus the cast line
 *   "the only figures are the uploaded subject and the required situation
 *   characters".
 * - VIDEO prompt carries the situation's desired motion verbatim (including
 *   its own camera language, e.g. a side-tracking shot) and never globally
 *   negates the action: no blanket "Locked camera" / "no camera movement".
 * - The negative prompt never bans the required monster/chase or camera
 *   movement; it only guards photographic/identity-substitution failure modes.
 */
import { BackendError } from "./contracts";
import { ScenarioRecord, selectScenarioSituation, SituationEvent } from "./scenario_catalog";

export interface CartoonPromptSelection {
  subject: string;
  action: string;
  sceneStyle: string;
}

export interface CartoonPrompts { still: string; motion: string; negative: string }

/**
 * Hard-coded appearance is rejected, but the generic preservation
 * instruction is required: only caller strings that pin a SPECIFIC person's
 * attributes (possessive + attribute, or a fixed outfit) fail. A generic
 * mention of glasses/hair/etc. as seen in the reference is correct and is
 * never rejected here.
 */
const HARD_CODED_APPEARANCE_RE =
  /\bpreserving\s+(his|her|their)\b|\b(his|her)\s+(glasses|beard|mustache|moustache|hairstyle|hair|blonde|brunette|outfit|suit)\b|\bwearing a (suit|tuxedo|gown|dress|uniform)\b/i;

/** The global negative guard: never bans the monster/chase or camera motion. */
const NEGATIVE_PROMPT =
  "photographic skin, pasted photographic face, identity substitution, photorealism, extra people, deformed hands, text, watermark, gore, 3D rendering";

/**
 * Generic preservation instruction: the only correct way to carry the
 * consenting subject's appearance. It names no specific person and fixes no
 * specific attributes; the model reads them from the subject_identity
 * reference bytes.
 */
const SUBJECT_PRESERVATION =
  "preserve the subject's actual distinctive attributes (glasses, facial hair, hairstyle, outfit) exactly as seen in the subject_identity reference";

/** Cast line: replaces every catalog "no people" fragment in the still. */
const CAST_LINE =
  "empty of pre-existing characters; the only figures are the uploaded subject and the required situation characters";

function assertPromptText(value: unknown, label: string, maxLength = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new BackendError("INVALID_ARGUMENT", `Cartoon prompt ${label} is invalid.`);
  }
  if (HARD_CODED_APPEARANCE_RE.test(value)) {
    throw new BackendError("INVALID_ARGUMENT", `Cartoon prompt ${label} must not hard-code one person's appearance.`);
  }
  return value.trim();
}

/** Rewrites catalog "no people" fragments to the neutral cast line. */
function neutralizeCastLine(value: string): string {
  return value.replace(/\bno people\b/gi, "empty of pre-existing characters");
}

/**
 * Catalog-backed composer: identity-first, static-pose still, motion-faithful
 * video, scene/style-last. Validates pair compatibility via
 * selectScenarioSituation (p1 gate).
 */
export function composeCartoonPromptsFromPair(
  scenario: ScenarioRecord,
  situation: SituationEvent,
): CartoonPrompts {
  if (!scenario || !situation) {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon scenario and situation are required.");
  }
  // Compatibility gate lives in p1; this call throws INVALID_ARGUMENT/NOT_FOUND
  // for unknown or incompatible pairs without duplicating the logic.
  selectScenarioSituation(
    { records: [scenario] } as unknown as Parameters<typeof selectScenarioSituation>[0],
    { events: [situation] } as unknown as Parameters<typeof selectScenarioSituation>[1],
    scenario.id,
    situation.id,
  );
  const action = assertPromptText(situation.action, "action", 4000);
  // Scene/style text comes from the catalog record only; "no people"
  // fragments are neutralized to the cast line so the still never denies the
  // required figures while still describing an empty opening set.
  const sceneStyle = assertPromptText(
    neutralizeCastLine(
      `${scenario.scenarioPrompt} ${scenario.stylePrompt} Constraints: ${scenario.situationConstraints} ${situation.constraints}`,
    ),
    "sceneStyle",
    4000,
  );
  return composeCartoonPrompts({ subject: "the person in the subject_identity reference (the uploaded subject)", action, sceneStyle });
}

/** Legacy free-form composer kept for unit tests; hard-coded appearance is rejected. */
export function composeCartoonPrompts(selection: CartoonPromptSelection): CartoonPrompts {
  if (!selection || typeof selection !== "object") {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon prompt selection is invalid.");
  }
  const subject = assertPromptText(selection.subject, "subject", 1200);
  const action = assertPromptText(selection.action, "action", 4000);
  const sceneStyle = neutralizeCastLine(assertPromptText(selection.sceneStyle, "sceneStyle", 4000));
  const still =
    `Subject and identity: use the subject_identity reference as the character identity. ` +
    `Redraw ${subject} as a coherent, fully illustrated cartoon character; ` +
    `${SUBJECT_PRESERVATION}, without photographic skin or pasted photographic details.\n` +
    `Static starting pose: a single unambiguous static pose at the opening of the scene, feet planted, ` +
    `facing the situation entrance; held still, no motion blur.\n` +
    `Scene and style: ${sceneStyle}\n` +
    `Cast: ${CAST_LINE}.`;
  const motion =
    `Animate the supplied illustrated first frame. ${action} ` +
    `Preserve the illustrated character identity and scene.`;
  return { still, motion, negative: NEGATIVE_PROMPT };
}
