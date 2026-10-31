import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { BackendError } from "../src/contracts";
import { composeCartoonPrompts, composeCartoonPromptsFromPair } from "../src/cartoon_prompts";
import {
  loadValidatedCatalogs,
  resolveFunctionsRoot,
  selectScenarioSituation,
} from "../src/scenario_catalog";

const FUNCTIONS_ROOT = resolveFunctionsRoot(resolve(__dirname, "../src"));

test("cartoon composer is identity-first, action-second, scene/style-last with negative prompt", () => {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  const { scenario, situation } = selectScenarioSituation(catalog, situations, "attic-computer-corner", "cramped-stumble-chase");
  const prompts = composeCartoonPromptsFromPair(scenario, situation);
  // Real prod path: catalog text flows into the composed prompts.
  assert.ok(prompts.still.includes(scenario.stylePrompt.slice(0, 24)));
  assert.ok(prompts.still.includes(situation.action.slice(0, 32)));
  assert.ok(prompts.motion.includes("Locked camera"));
  assert.ok(prompts.negative.length > 10);
  // Ordering: identity reference first, action beat second, scene/style last.
  const identityAt = prompts.still.indexOf("subject_identity");
  const actionAt = prompts.still.indexOf(situation.action.slice(0, 32));
  const styleAt = prompts.still.indexOf(scenario.stylePrompt.slice(0, 24));
  assert.ok(identityAt >= 0 && actionAt > identityAt && styleAt > actionAt);
  // Negative prompt carries the photographic/identity-substitution guard.
  assert.match(prompts.negative, /photographic skin/);
  assert.match(prompts.negative, /identity substitution/);
  // Never hard-codes any one person's appearance.
  for (const token of ["glasses", "beard", "mustache", "blonde"]) {
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
  assert.throws(
    () => composeCartoonPrompts({ subject: "the man with glasses and beard", action: "runs left to right across the room with a monster chase", sceneStyle: "spooky attic in flat cartoon style" }),
    (error: unknown) => error instanceof BackendError && /appearance/.test(error.message),
  );
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
  const images = (fixture.body.input as Record<string, unknown>).images as unknown[];
  assert.equal(images.length, 2);
  for (const url of images) assert.match(String(url), /^https:\/\//);
  assert.equal((fixture.body.parameters as Record<string, unknown>).negative_prompt, prompts.negative);
  assert.ok(!JSON.stringify(fixture.body).includes("parties/"));
});
