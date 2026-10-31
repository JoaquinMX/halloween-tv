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

test("cartoon composer is identity-first, static-pose still, motion-faithful video, scene/style-last", () => {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  const { scenario, situation } = selectScenarioSituation(catalog, situations, "attic-computer-corner", "cramped-stumble-chase");
  const prompts = composeCartoonPromptsFromPair(scenario, situation);
  // Real prod path: catalog text flows into the composed prompts.
  assert.ok(prompts.still.includes(scenario.stylePrompt.slice(0, 24)));
  assert.ok(prompts.motion.includes(situation.action.slice(0, 32)));
  assert.ok(prompts.negative.length > 10);
  // Ordering: identity reference first, static pose second, scene/style last.
  // The still carries NO motion language (the timed choreography belongs to
  // the video stage only).
  const identityAt = prompts.still.indexOf("subject_identity");
  const poseAt = prompts.still.indexOf("Static starting pose");
  const styleAt = prompts.still.indexOf(scenario.stylePrompt.slice(0, 24));
  assert.ok(identityAt >= 0 && poseAt > identityAt && styleAt > poseAt);
  assert.ok(!prompts.still.includes("0-1s:"));
  assert.match(prompts.still, /Static starting pose/);
  for (const token of ["sprints", "face-plants", "windmill", "scramble and burst"]) {
    assert.ok(!prompts.still.toLowerCase().includes(token), `still must carry no motion language (${token})`);
  }
  assert.ok(!prompts.still.includes(situation.action), "the timed action choreography belongs to the video stage only");
  // The still never says "no people": the cast line names the figures.
  assert.ok(!/no people/i.test(prompts.still));
  assert.match(prompts.still, /empty of pre-existing characters/);
  assert.match(prompts.still, /the only figures are the uploaded subject and the required situation characters/);
  // Generic preservation is required: the subject's actual attributes ride a
  // generic instruction, never a hard-coded person.
  assert.match(prompts.still, /preserve the subject's actual distinctive attributes/);
  // The video carries the situation's desired motion verbatim, including its
  // own camera language — never a global motion negation.
  assert.ok(!/locked camera/i.test(prompts.motion));
  assert.ok(!/no camera movement/i.test(prompts.motion));
  assert.match(prompts.motion, /side-tracking shot/);
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
