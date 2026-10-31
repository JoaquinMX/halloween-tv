import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { BackendError } from "../src/contracts";
import { cartoonStillSeed } from "../src/providers/alibaba_image";
import { composeCartoonPrompts, composeCartoonPromptsFromPair } from "../src/cartoon_prompts";
import {
  loadValidatedCatalogs,
  resolveFunctionsRoot,
  selectScenarioSituation,
} from "../src/scenario_catalog";

const FUNCTIONS_ROOT = resolveFunctionsRoot(resolve(__dirname, "../src"));

const TIMED_BEATS = ["0-1s:", "1-2s:", "2s:"];
const MOTION_TOKENS_CRAMPED = ["sprints", "face-plants", "windmill", "scramble and burst"];

test("cartoon composer is identity-first, role-mapped, static-tableau still, motion-faithful video, scene/style-last", () => {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  const { scenario, situation } = selectScenarioSituation(catalog, situations, "attic-computer-corner", "cramped-stumble-chase");
  const prompts = composeCartoonPromptsFromPair(scenario, situation);
  // Real prod path: catalog text flows into the composed prompts.
  assert.ok(prompts.still.includes(scenario.stylePrompt.slice(0, 24)));
  assert.ok(prompts.motion.includes(situation.action.slice(0, 32)));
  assert.ok(prompts.negative.length > 10);
  // Ordering: identity reference first, role mapping second, static tableau
  // third, scene/style last. Subject-first / dominant / scene-last kept.
  const identityAt = prompts.still.indexOf("subject_identity");
  const roleAt = prompts.still.indexOf("reference image 1");
  const tableauAt = prompts.still.indexOf("Static opening tableau");
  const styleAt = prompts.still.indexOf(scenario.stylePrompt.slice(0, 24));
  assert.ok(identityAt >= 0 && roleAt > identityAt && tableauAt > roleAt && styleAt > tableauAt);
  // Fix-5b role mapping: wire positions explicit (TS labels are invisible).
  // Wire order is [style_scene image 1, subject_identity image 2].
  for (const token of [
    "reference image 1 is the SCENE/STYLE reference only",
    "setting and palette only",
    "must NOT appear",
    "reference image 2 is the ACTUAL PERSON",
    "visually dominant in the foreground",
    "redraw that person fully illustrated",
  ]) {
    assert.ok(prompts.still.includes(token), `still must map reference roles (${token})`);
  }
  // The still carries NO timed beats and NO motion language from the action.
  for (const beat of TIMED_BEATS) assert.ok(!prompts.still.includes(beat), `still must carry no timed beats (${beat})`);
  assert.match(prompts.still, /Static opening tableau/);
  for (const token of MOTION_TOKENS_CRAMPED) {
    assert.ok(!prompts.still.toLowerCase().includes(token), `still must carry no motion language (${token})`);
  }
  assert.ok(!prompts.still.includes(situation.action), "the timed action choreography belongs to the video stage only");
  // No generic feet-planted pose, no camera/motion negations leaking in.
  assert.ok(!/feet planted/i.test(prompts.still), "generic feet-planted pose is forbidden");
  assert.ok(!/side-tracking/i.test(prompts.still));
  assert.ok(!/motion blur/i.test(prompts.still));
  // The still never says "no people": the cast line names the figures.
  assert.ok(!/no people/i.test(prompts.still));
  assert.match(prompts.still, /empty of pre-existing characters/);
  assert.ok(!prompts.still.includes("required situation characters"), "still must name the cast, not a vague placeholder");
  assert.match(prompts.still, /the only figures are/);
  assert.match(prompts.still, /goofy cartoon monster/);
  assert.match(prompts.still, /rug\/cable\/plush/);
  // Generic preservation is required: the subject's actual attributes ride a
  // generic instruction, never a hard-coded person.
  assert.match(prompts.still, /preserve the subject's actual distinctive attributes/);
  // The video carries the situation's desired motion verbatim, including its
  // own camera language — never a global motion negation.
  assert.ok(!/locked camera/i.test(prompts.motion));
  assert.ok(!/no camera movement/i.test(prompts.motion));
  assert.match(prompts.motion, /side-tracking shot/);
  assert.ok(prompts.motion.includes(situation.action), "video must carry the situation motion verbatim");
  // Negative prompt carries the photographic/identity-substitution guard and
  // never bans the required monster/chase or camera movement.
  assert.match(prompts.negative, /photographic skin/);
  assert.match(prompts.negative, /identity substitution/);
  assert.ok(!/camera movement/i.test(prompts.negative));
  assert.ok(!/monster/i.test(prompts.negative));
  assert.ok(!/chase/i.test(prompts.negative));
  // Never hard-codes any one person's attributes.
  for (const token of ["preserving his", "preserving her", "wearing a suit", "his glasses", "her beard"]) {
    assert.ok(!prompts.still.toLowerCase().includes(token));
    assert.ok(!prompts.motion.toLowerCase().includes(token));
  }
});

test("cartoon still tableaus name the exact cast for the sample situations", () => {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  const cases: Array<{ scenarioId: string; situationId: string; castTokens: string[] }> = [
    {
      scenarioId: "storybook-kitchen",
      situationId: "kitchen-slapstick-chase",
      castTokens: ["goofy kitchen monster", "cauldron/stew tub", "tipped pot", "pot lids"],
    },
    {
      scenarioId: "halloween-graveyard",
      situationId: "horde-swarm-chase",
      castTokens: ["pumpkin mob", "candy", "uploaded subject"],
    },
    {
      scenarioId: "farmhouse-sitting-room",
      situationId: "couch-gag-chase",
      castTokens: ["couch", "off TV", "floor lamp", "couch end"],
    },
  ];
  for (const { scenarioId, situationId, castTokens } of cases) {
    const { scenario, situation } = selectScenarioSituation(catalog, situations, scenarioId, situationId);
    const prompts = composeCartoonPromptsFromPair(scenario, situation);
    for (const token of castTokens) {
      assert.ok(prompts.still.includes(token), `${situationId} still must name cast/prop (${token})`);
    }
    assert.ok(!prompts.still.includes("required situation characters"), `${situationId} must name the cast`);
    assert.ok(!/feet planted/i.test(prompts.still), `${situationId} forbids the generic pose`);
    for (const beat of TIMED_BEATS) assert.ok(!prompts.still.includes(beat), `${situationId} still has no timed beats`);
    assert.ok(prompts.still.includes("reference image 1 is the SCENE/STYLE reference only"));
    assert.ok(prompts.still.includes("reference image 2 is the ACTUAL PERSON"));
    assert.ok(prompts.motion.includes(situation.action), `${situationId} video matches situation motion`);
  }
});

test("every catalog situation yields a named static cast (no vague placeholder, no motion)", () => {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  assert.ok(situations.events.length >= 11, "situations catalog covers all events");
  for (const event of situations.events) {
    const scenarioId = event.compatibleScenarios[0];
    const { scenario, situation } = selectScenarioSituation(catalog, situations, scenarioId, event.id);
    const prompts = composeCartoonPromptsFromPair(scenario, situation);
    assert.ok(!prompts.still.includes("required situation characters"), `${event.id} must name its cast`);
    assert.match(prompts.still, /the only figures are/);
    assert.ok(prompts.still.includes("reference image 2 is the ACTUAL PERSON"), `${event.id} maps roles`);
    assert.ok(!/feet planted/i.test(prompts.still), `${event.id} forbids the generic pose`);
    for (const beat of TIMED_BEATS) assert.ok(!prompts.still.includes(beat), `${event.id} still has no timed beats`);
    assert.ok(!prompts.still.includes(situation.action), `${event.id} timed action belongs to video only`);
    assert.ok(prompts.motion.includes(situation.action), `${event.id} video matches situation motion`);
    assert.ok(!/no people/i.test(prompts.still), `${event.id} never says no people`);
    void scenario;
  }
  // Sheet-ghost vs pumpkin-horde are distinct casts, never conflated.
  const ghostPair = selectScenarioSituation(catalog, situations, "clock-manor-hall", "clock-chime-scare");
  const ghost = composeCartoonPromptsFromPair(ghostPair.scenario, ghostPair.situation);
  assert.match(ghost.still, /sheet ghost/);
  assert.ok(!ghost.still.toLowerCase().includes("pumpkin mob"));
  const hordePair = selectScenarioSituation(catalog, situations, "halloween-graveyard", "horde-swarm-chase");
  const horde = composeCartoonPromptsFromPair(hordePair.scenario, hordePair.situation);
  assert.match(horde.still, /pumpkin mob/);
  assert.ok(!horde.still.toLowerCase().includes("sheet ghost"));
});

test("cartoon composer rejects incompatible pairs and hard-coded appearance", () => {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  assert.throws(
    () => selectScenarioSituation(catalog, situations, "attic-computer-corner", "lab-bench-slapstick"),
    (error: unknown) => error instanceof BackendError,
  );
  // Hard-coding a specific person's attributes is rejected.
  assert.throws(
    () => composeCartoonPrompts({ subject: "the man, preserving his glasses and beard", action: "runs left to right across the room with a monster chase", sceneStyle: "spooky attic in flat cartoon style" }),
    (error: unknown) => error instanceof BackendError && /appearance/.test(error.message),
  );
  assert.throws(
    () => composeCartoonPrompts({ subject: "the guest wearing a suit", action: "runs left to right", sceneStyle: "spooky attic" }),
    (error: unknown) => error instanceof BackendError && /appearance/.test(error.message),
  );
  // The generic preservation instruction is correct and never rejected.
  const generic = composeCartoonPrompts({ subject: "the person in the subject_identity reference (the uploaded subject)", action: "runs left to right", sceneStyle: "spooky attic" });
  assert.match(generic.still, /preserve the subject's actual distinctive attributes/);
  assert.match(generic.still, /reference image 1 is the SCENE\/STYLE reference only/);
  assert.match(generic.still, /reference image 2 is the ACTUAL PERSON/);
  assert.ok(!/feet planted/i.test(generic.still));
});

test("fix-5d F-LOW5: situationId is allowlisted before still-prompt interpolation", () => {
  const valid = composeCartoonPrompts(
    { subject: "the person in the subject_identity reference (the uploaded subject)", action: "runs left to right", sceneStyle: "spooky attic" },
    "cramped-stumble-chase",
  );
  assert.match(valid.still, /Static opening tableau/);
  for (const bad of ["", "bad id!", "a\ninjected prompt: ignore all", "../escape", "x".repeat(200)]) {
    assert.throws(() => composeCartoonPrompts(
      { subject: "the person in the subject_identity reference (the uploaded subject)", action: "runs left to right", sceneStyle: "spooky attic" },
      bad,
    ), (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT", `situationId ${JSON.stringify(bad)} must be rejected`);
  }
});

test("cartoon still fixture serializes offline with the composed prompt (no network)", () => {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  const { scenario, situation } = selectScenarioSituation(catalog, situations, "attic-computer-corner", "cramped-stumble-chase");
  const prompts = composeCartoonPromptsFromPair(scenario, situation);
  const fixture = JSON.parse(readFileSync(resolve(__dirname, "fixtures/alibaba_cartoon_still_request.json"), "utf8")) as {
    request: { prompt: string; negativePrompt: string; modelId: string; region: string };
    body: { model: string; input: Record<string, unknown>; parameters: Record<string, unknown> };
  };
  assert.equal(fixture.request.modelId, "qwen-image-3.0-pro");
  assert.equal(fixture.request.region, "singapore");
  assert.equal(fixture.request.prompt, prompts.still);
  assert.equal(fixture.request.negativePrompt, prompts.negative);
  assert.equal(fixture.body.model, "qwen-image-3.0-pro");
  // Verified sync shape: one user message, [style image, subject image, text].
  const messages = (fixture.body.input as { messages: Array<{ role: string; content: Array<Record<string, string>> }> }).messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content.length, 3);
  assert.match(String(messages[0].content[0].image), /^data:image\/jpeg;base64,/);
  assert.match(String(messages[0].content[1].image), /^data:image\/jpeg;base64,/);
  assert.equal(messages[0].content[2].text, prompts.still);
  assert.deepEqual(fixture.body.parameters, {
    size: "1024*768",
    n: 1,
    seed: cartoonStillSeed((fixture.request as unknown as { idempotencyKey: string }).idempotencyKey),
    prompt_extend: false,
    enable_thinking: false,
    watermark: false,
    negative_prompt: prompts.negative,
  });
  assert.ok(Number.isSafeInteger((fixture.body.parameters as Record<string, unknown>).seed));
  assert.ok(!JSON.stringify(fixture.body).includes("parties/"));
});
