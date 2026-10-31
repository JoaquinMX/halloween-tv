/**
 * Server-owned, two-stage cartoon prompt composition (cycle-13 p2, cycle-13 fix-3, cycle-13 fix-5b).
 *
 * Programs against the p1 catalog (scenario_catalog.ts) and never duplicates
 * its validation: callers pass validated ScenarioRecord/SituationEvent pairs
 * (via selectScenarioSituation), and this module only orders their text into
 * the fixed identity-first / static-tableau-then-scene envelope for the still
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
 * core/network/src/main/java/com/android/developers/androidify/RemoteDataSource.kt.
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
 *   rewritten to "empty of pre-existing characters" plus a cast line.
 * - VIDEO prompt carries the situation's desired motion verbatim (including
 *   its own camera language, e.g. a side-tracking shot) and never globally
 *   negates the action: no blanket "Locked camera" / "no camera movement".
 * - The negative prompt never bans the required monster/chase or camera
 *   movement; it only guards photographic/identity-substitution failure modes.
 *
 * Fix-5b reference-role + tableau closure:
 * - TypeScript role labels are invisible to the image model, and the verified
 *   wire order is [style_scene image, subject_identity image] (see
 *   providers/alibaba_image.ts buildAlibabaImageSubmitBody). The still prompt
 *   therefore maps positions explicitly: reference image 1 is the
 *   SCENE/STYLE reference only (setting and palette only; pre-existing
 *   characters, if any, must NOT appear), and reference image 2 is the
 *   ACTUAL PERSON (uploaded subject identity), visually dominant in the
 *   foreground and redrawn fully illustrated.
 * - The still carries a situation-specific STATIC opening tableau naming the
 *   exact cast/props/setting for THIS situation (derived from the situation
 *   record choreography, e.g. sheet ghost vs pumpkin mob), with a
 *   situation-specific held pose — never the generic "feet planted" pose,
 *   never motion language, never timed beats. The video stage animates THAT
 *   still with the situation's timed motion verbatim.
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

/**
 * Explicit wire-position mapping. TypeScript role labels never reach the
 * model, so the still prompt names positions: image 1 is style/scene only,
 * image 2 is the actual person, dominant in the foreground. Subject-first /
 * dominant-foreground / scene-and-style-last ordering is preserved: the
 * subject identity opens the prompt and the scene/style closes it.
 */
const REFERENCE_ROLE_MAPPING =
  "Reference roles: reference image 1 is the SCENE/STYLE reference only (its pre-existing characters, if any, must NOT appear — setting and palette only); " +
  "reference image 2 is the ACTUAL PERSON (uploaded subject identity), who must be visually dominant in the foreground; " +
  "redraw that person fully illustrated preserving their actual distinctive attributes.";

/** Per-situation static tableau + named cast (fix-5b). All text is STATIC: no motion verbs, no timed beats. */
interface SituationTableau { cast: string; tableau: string }

const TABLEAU_BY_SITUATION_ID: Record<string, SituationTableau> = {
  "cramped-stumble-chase": {
    cast: "the uploaded subject (foreground, visually dominant) and one goofy cartoon monster a step behind",
    tableau:
      "Static opening tableau: the uploaded subject stands center-foreground in a calm poised stance beside a rug/cable/plush prop from the room, " +
      "the goofy cartoon monster stationed one step behind with an outstretched arm; tight-room doorway and set dressing frame the pair; all figures and props hold completely still with sharp static clarity",
  },
  "grand-staircase-chase": {
    cast: "the uploaded subject (foreground, visually dominant) and one cartoon monster on the stairs",
    tableau:
      "Static opening tableau: the uploaded subject stands center-foreground on the upper staircase beside the long rug, " +
      "the cartoon monster stationed a few steps above with an outstretched arm; tall windows and rug pattern frame the pair; all figures hold completely still with sharp static clarity",
  },
  "lab-bench-slapstick": {
    cast: "the uploaded subject (foreground, visually dominant) and one slapstick cartoon monster at the next bench",
    tableau:
      "Static opening tableau: the uploaded subject stands center-foreground between workbenches beside rounded unbreakable flasks, " +
      "hanging cables overhead and an oversized keyboard platform nearby, the slapstick cartoon monster stationed at the next bench; chalkboard and lab benches frame the pair; all figures and props hold completely still with sharp static clarity",
  },
  "kitchen-slapstick-chase": {
    cast: "the uploaded subject (foreground, visually dominant) and one goofy kitchen monster by the cauldron",
    tableau:
      "Static opening tableau: the uploaded subject stands center-foreground beside a tipped pot and the cauldron/stew tub, " +
      "pot lids arranged as set dressing nearby with a flour/steam puff prop in place, the goofy kitchen monster stationed a step behind; hearth and stone-arch kitchen frames the pair; all figures and props hold completely still with sharp static clarity",
  },
  "couch-gag-chase": {
    cast: "the uploaded subject (foreground, visually dominant) and one cartoon monster at the couch end",
    tableau:
      "Static opening tableau: the uploaded subject stands center-foreground beside the couch with cushions in place, " +
      "rug edge and floor lamp nearby and the off TV set in the background, the cartoon monster stationed at the couch end; living-room set frames the pair; all figures and props hold completely still with sharp static clarity",
  },
  "mask-lunge-scare": {
    cast: "the uploaded subject (foreground, visually dominant) and exactly one green mask-monster with mismatched eyes",
    tableau:
      "Static opening tableau: the uploaded subject stands center-foreground at the room center in a calm poised stance, " +
      "the single green mask-monster with mismatched eyes stationed at the doorway/furniture side half in shadow; domestic interior frames the pair; all figures hold completely still with sharp static clarity",
  },
  "horde-swarm-chase": {
    cast: "the uploaded subject (foreground, visually dominant) and a goofy pumpkin mob with the monster among them",
    tableau:
      "Static opening tableau: the uploaded subject stands center-foreground on the road/path in a calm poised stance, " +
      "the goofy pumpkin mob with the monster among them stationed along both sides with scattered candy and harmless props; night/dusk outdoor set with graves and fields frames the group; all figures hold completely still with sharp static clarity",
  },
  "van-door-slam-gag": {
    cast: "the uploaded subject (foreground, visually dominant) and one goofy cartoon monster at the van corner",
    tableau:
      "Static opening tableau: the uploaded subject stands center-foreground beside the parked van with its sliding door and hubcap in place, " +
      "the goofy cartoon monster stationed at the van corner; road/porch exterior frames the pair; all figures and props hold completely still with sharp static clarity",
  },
  "clock-chime-scare": {
    cast: "the uploaded subject (foreground, visually dominant) and one small sheet ghost by the clock wall",
    tableau:
      "Static opening tableau: the uploaded subject stands center-foreground mid-room by the settee in a calm poised stance, " +
      "the small sheet ghost stationed beside the clock wall with cuckoo/grandfather clock faces visible; haunted-hall set frames the pair; all figures hold completely still with sharp static clarity",
  },
  "porch-daylight-gag": {
    cast: "the uploaded subject (foreground, visually dominant) and one goofy cartoon monster at the porch corner",
    tableau:
      "Static opening tableau: the uploaded subject stands center-foreground on the lawn by the porch steps in a calm poised stance, " +
      "the goofy cartoon monster stationed at the porch corner with its long shadow cast across the lawn, garage door and house corner in place; daylight house exterior frames the pair; all figures hold completely still with sharp static clarity",
  },
  "toy-room-chase": {
    cast: "the uploaded subject (foreground, visually dominant) and one cartoon monster at the doorway side",
    tableau:
      "Static opening tableau: the uploaded subject stands center-foreground among plush toys and bots with round windows behind, " +
      "the heart bed with its skirt nearby, the cartoon monster stationed at the doorway side; playful bedroom set frames the pair; all figures and props hold completely still with sharp static clarity",
  },
};

/** Generic fallback tableau for free-form selections (no situation id): static, named cast, no banned phrase. */
const GENERIC_TABLEAU: SituationTableau = {
  cast: "the uploaded subject (foreground, visually dominant) and the companion figures for the staged interaction",
  tableau:
    "Static opening tableau for this selection: the uploaded subject stands center-foreground in a calm poised stance within the scene described below, " +
    "companion figures and props for the staged interaction stationed beside them; all figures and props hold completely still with sharp static clarity",
};

function tableauForSituationId(situationId: string): SituationTableau {
  return TABLEAU_BY_SITUATION_ID[situationId] ?? {
    cast: `the uploaded subject (foreground, visually dominant) and the companion figures for situation ${situationId}`,
    tableau:
      `Static opening tableau for situation ${situationId}: the uploaded subject stands center-foreground in a calm poised stance within the scene described below, ` +
      `companion figures and props for this situation stationed beside them; all figures and props hold completely still with sharp static clarity`,
  };
}

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
 * Catalog-backed composer: identity-first, static-tableau still, motion-faithful
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
  // fragments are neutralized so the still never denies the required figures
  // while still describing an empty opening set.
  const sceneStyle = assertPromptText(
    neutralizeCastLine(
      `${scenario.scenarioPrompt} ${scenario.stylePrompt} Constraints: ${scenario.situationConstraints} ${situation.constraints}`,
    ),
    "sceneStyle",
    4000,
  );
  return composeCartoonPrompts(
    { subject: "the person in the subject_identity reference (the uploaded subject)", action, sceneStyle },
    situation.id,
  );
}

/** Legacy free-form composer kept for unit tests; hard-coded appearance is rejected. */
export function composeCartoonPrompts(selection: CartoonPromptSelection, situationId?: string): CartoonPrompts {
  if (!selection || typeof selection !== "object") {
    throw new BackendError("INVALID_ARGUMENT", "Cartoon prompt selection is invalid.");
  }
  const subject = assertPromptText(selection.subject, "subject", 1200);
  const action = assertPromptText(selection.action, "action", 4000);
  const sceneStyle = neutralizeCastLine(assertPromptText(selection.sceneStyle, "sceneStyle", 4000));
  const tableau = situationId !== undefined ? tableauForSituationId(situationId) : GENERIC_TABLEAU;
  const still =
    `Subject and identity: use the subject_identity reference as the character identity. ` +
    `Redraw ${subject} as a coherent, fully illustrated cartoon character; ` +
    `${SUBJECT_PRESERVATION}, without photographic skin or pasted photographic details.\n` +
    `${REFERENCE_ROLE_MAPPING}\n` +
    `${tableau.tableau}.\n` +
    `Scene and style: ${sceneStyle}\n` +
    `Cast: empty of pre-existing characters; the only figures are ${tableau.cast}.`;
  const motion =
    `Animate the supplied illustrated first frame. ${action} ` +
    `Preserve the illustrated character identity and scene.`;
  return { still, motion, negative: NEGATIVE_PROMPT };
}
