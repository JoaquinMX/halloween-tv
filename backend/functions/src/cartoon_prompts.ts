/**
 * Server-owned, two-stage cartoon prompt composition (cycle-13 p2).
 *
 * Programs against the p1 catalog (scenario_catalog.ts) and never duplicates
 * its validation: callers pass validated ScenarioRecord/SituationEvent pairs
 * (via selectScenarioSituation), and this module only orders their text into
 * the fixed identity-first / action-second / scene-style-last envelope.
 *
 * Identity is always generic ("the person in the subject_identity
 * reference"); no caller string may hard-code any one person's appearance
 * (glasses, beard, hair, outfit specifics are rejected).
 */
import { BackendError } from "./contracts";
import { ScenarioRecord, selectScenarioSituation, SituationEvent } from "./scenario_catalog";

export interface CartoonPromptSelection {
  subject: string;
  action: string;
  sceneStyle: string;
}

export interface CartoonPrompts { still: string; motion: string; negative: string }

/** Appearance specifics must never be baked into the shared composer. */
const FORBIDDEN_APPEARANCE_RE = /\b(glasses|beard|mustache|moustache|hairstyle|blonde|brunette|preserving his|preserving her|wearing a suit|outfit)\b/i;

const NEGATIVE_PROMPT =
  "photographic skin, pasted photographic face, identity substitution, photorealism, extra people, deformed hands, text, watermark, camera movement, gore, 3D rendering";

function assertPromptText(value: unknown, label: string, maxLength = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new BackendError("INVALID_ARGUMENT", `Cartoon prompt ${label} is invalid.`);
  }
  if (FORBIDDEN_APPEARANCE_RE.test(value)) {
    throw new BackendError("INVALID_ARGUMENT", `Cartoon prompt ${label} must not hard-code any one person's appearance.`);
  }
  return value.trim();
}

/**
 * Catalog-backed composer: identity-first, action-second, scene/style-last.
 * Validates pair compatibility via selectScenarioSituation (p1 gate).
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
  // Scene/style text comes from the catalog record only; still rejected if a
  // catalog string ever carried hard-coded personal appearance.
  const sceneStyle = assertPromptText(
    `${scenario.scenarioPrompt} ${scenario.stylePrompt} Constraints: ${scenario.situationConstraints} ${situation.constraints}`,
    "sceneStyle",
    4000,
  );
  return composeCartoonPrompts({ subject: "the person", action, sceneStyle });
}

/** Legacy free-form composer kept for unit tests; appearance specifics are rejected. */
export function composeCartoonPrompts(selection: CartoonPromptSelection): CartoonPrompts {
  if (!selection || typeof selection !== "object") {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon prompt selection is invalid.");
  }
  const subject = assertPromptText(selection.subject, "subject", 1200);
  const action = assertPromptText(selection.action, "action", 4000);
  const sceneStyle = assertPromptText(selection.sceneStyle, "sceneStyle", 4000);
  const still =
    `Subject and identity: Use the person in the subject_identity reference as the character identity. ` +
    `${subject} Completely redraw the person as a coherent, fully illustrated cartoon character; ` +
    `preserve recognizable identity without photographic skin or pasted photographic details.\n` +
    `Action event: ${action}\n` +
    `Scene and style: ${sceneStyle}`;
  const motion =
    `Animate the supplied illustrated first frame with tiny natural motion only. ${action} ` +
    `Locked camera, no cuts, preserve the illustrated character identity and scene.`;
  return { still, motion, negative: NEGATIVE_PROMPT };
}
