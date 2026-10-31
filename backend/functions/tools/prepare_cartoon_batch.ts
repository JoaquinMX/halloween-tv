/**
 * Cartoon catalog few-case batch preview (cycle-13 fix-3, preview-only).
 *
 * Emits a 3-case preview of 3 DISTINCT scenario+situation pairs for owner
 * review. Each case carries the scenario id/version, situation id/version,
 * selection seed, BOTH repo-relative reference paths, the EXACT composed
 * still prompt + video prompt, model pins, and the owner max-credit gate.
 *
 * Reference paths (both repo-relative, both on disk):
 * - style_scene: the image-backed catalog reference
 *   (assets/scenario_refs/..., sha256/sizeBytes pinned in
 *   scenario_catalog.v1.json and re-verified here);
 * - subject_identity: the committed byte-shape stand-in
 *   test/fixtures/guest_photo.jpg, used ONLY to prove the still-stage byte
 *   shape offline. It is never a real portrait: real batches use consented
 *   ingest portraits, and private portrait bytes stay out of review
 *   documents.
 *
 * Spend safety: this tool has NO live path. It never constructs a provider,
 * never signs reference URLs, never writes Firestore/Storage, and exits
 * nonzero unless `--max-credits` (owner-supplied ceiling) is present.
 * Credits stay UNKNOWN (null): Token Plan prices are never invented.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { CARTOON_CATALOG_SCENARIOS, CARTOON_STILL_PRESET, CARTOON_VIDEO_PRESET } from "../src/contracts";
import { composeCartoonPromptsFromPair } from "../src/cartoon_prompts";
import {
  getScenario,
  getSituation,
  loadValidatedCatalogs,
  readScenarioReferenceBytes,
  resolveFunctionsRoot,
  selectScenarioSituation,
} from "../src/scenario_catalog";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function fail(message: string): never {
  throw new Error(message);
}

function requireId(label: string, value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    fail(`prepare_cartoon_batch requires explicit --${label}=<registered-id> (portable value, no secrets).`);
  }
  return value;
}

/** Repo-relative guard: preview artifacts must stay inside the checkout. */
function requireRepoRelative(functionsRoot: string, path: string, label: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.startsWith("~") || /^[A-Za-z]:/.test(normalized) || normalized.includes("..")) {
    fail(`${label} must be a repo-relative path (found ${JSON.stringify(path)}).`);
  }
  const absolute = resolve(functionsRoot, normalized);
  if (absolute !== resolve(functionsRoot) && !absolute.startsWith(`${resolve(functionsRoot)}${sep}`)) {
    fail(`${label} escapes the functions root (found ${JSON.stringify(path)}).`);
  }
  if (!existsSync(absolute)) fail(`${label} is missing on disk: ${path}.`);
  return normalized;
}

async function main(): Promise<void> {
  const party = requireId("party", argument("party") ?? process.env.PARTY_ID);
  const device = requireId("device", argument("device") ?? process.env.DEVICE_ID);
  const channel = requireId("channel", argument("channel") ?? process.env.CHANNEL_ID);
  const maxCreditsRaw = argument("max-credits") ?? process.env.CARTOON_MAX_CREDITS;
  if (maxCreditsRaw === undefined || maxCreditsRaw.trim() === "") {
    fail("prepare_cartoon_batch requires an explicit owner-supplied ceiling: --max-credits=<number> (mandatory budget gate).");
  }
  const maxCredits = Number(maxCreditsRaw);
  if (!Number.isFinite(maxCredits) || maxCredits <= 0) {
    fail("--max-credits must be a positive number of Token Plan Credits (owner-supplied; no price is invented here).");
  }
  if (process.argv.includes("--live") || process.argv.includes("--apply") || process.argv.includes("--confirm-budget-guard")) {
    fail("prepare_cartoon_batch is preview-only: it never submits live requests; remove --live/--apply/--confirm-budget-guard.");
  }

  // Identity linkage: planner rows bind real validated catalog records, so
  // the 3 cases resolve to hashed catalog bytes, never synthetic slot ids.
  const functionsRoot = resolveFunctionsRoot(resolve(__dirname, "../src"));
  const { catalog, situations } = loadValidatedCatalogs(functionsRoot);
  if (catalog.records.length !== CARTOON_CATALOG_SCENARIOS.length) {
    fail(`Catalog record count (${catalog.records.length}) does not match planner slots (${CARTOON_CATALOG_SCENARIOS.length}).`);
  }

  // Deterministic few-case selection: fixed selection seeds pick 3 DISTINCT
  // scenario+situation pairs (seeded, reproducible, owner-reviewable).
  const selectionSeeds = ["cartoon-batch-case-1", "cartoon-batch-case-2", "cartoon-batch-case-3"];
  const picked: Array<{ scenarioId: string; situationId: string; seed: string }> = [];
  for (const seed of selectionSeeds) {
    const { buildAutoCartoonPlan } = await import("../src/cartoon_pipeline");
    const plan = buildAutoCartoonPlan({ submissionId: seed, catalog, situations });
    picked.push({ scenarioId: plan.scenarioId, situationId: plan.situationId, seed });
  }
  const pairs = new Set(picked.map((entry) => `${entry.scenarioId}:${entry.situationId}`));
  if (pairs.size !== picked.length) {
    fail("Batch selection collided: the 3 preview cases must be DISTINCT scenario+situation pairs.");
  }

  const subjectStandInRepoPath = requireRepoRelative(functionsRoot, join("test", "fixtures", "guest_photo.jpg"), "subject_identity stand-in");

  const rows = picked.map(({ scenarioId, situationId, seed }, index) => {
    const { scenario, situation } = selectScenarioSituation(catalog, situations, scenarioId, situationId);
    // Hash-verified style reference: readScenarioReferenceBytes rejects
    // missing/altered files before the row is emitted.
    readScenarioReferenceBytes(scenario, functionsRoot);
    const scenarioRecord = getScenario(catalog, scenarioId);
    const situationEvent = getSituation(situations, situationId);
    const prompts = composeCartoonPromptsFromPair(scenario, situation);
    // Fixed slot for the chosen scenario: the planner slot follows the
    // catalog record order, exactly as the server auto-select persists it.
    const scenarioIndex = catalog.records.findIndex((record) => record.id === scenarioId);
    const slot = CARTOON_CATALOG_SCENARIOS[scenarioIndex % CARTOON_CATALOG_SCENARIOS.length];
    return {
      case: index + 1,
      selectionSeed: seed,
      scenario: { id: scenarioRecord.id, version: scenarioRecord.version },
      situation: { id: situationEvent.id, version: situationEvent.version },
      referencePaths: {
        // Still -> video role ordering preserved: the generated still becomes
        // the video first_frame; the still stage itself takes subject_identity
        // (portrait) + style_scene (catalog reference).
        subjectIdentity: subjectStandInRepoPath,
        subjectIdentityNote: "byte-shape stand-in only (committed fixture); real batches use consented ingest portraits, never review documents",
        styleScene: scenarioRecord.referencePath,
      },
      catalogReference: { sourceFilename: scenarioRecord.sourceFilename, sha256: scenarioRecord.sha256, sizeBytes: scenarioRecord.sizeBytes },
      stillPrompt: prompts.still,
      videoPrompt: prompts.motion,
      negativePrompt: prompts.negative,
      still: {
        planId: slot.stillPlanId,
        version: slot.version,
        seed: slot.seed,
        modelId: CARTOON_STILL_PRESET.modelId,
        region: CARTOON_STILL_PRESET.region,
        provider: CARTOON_STILL_PRESET.provider,
        inputs: "separately identified portrait reference + scene/style reference (in-process data URIs, no hosting)",
        submissions: 1,
      },
      video: {
        planId: slot.videoPlanId,
        version: slot.version,
        seed: slot.seed,
        modelId: CARTOON_VIDEO_PRESET.modelId,
        region: CARTOON_VIDEO_PRESET.region,
        resolution: CARTOON_VIDEO_PRESET.resolution,
        secondsOut: CARTOON_VIDEO_PRESET.secondsOut,
        aspectRatio: CARTOON_VIDEO_PRESET.aspectRatio,
        audio: CARTOON_VIDEO_PRESET.audio,
        outputs: CARTOON_VIDEO_PRESET.outputs,
        autoUpscale: CARTOON_VIDEO_PRESET.autoUpscale,
        promptExtend: CARTOON_VIDEO_PRESET.promptExtend,
        watermark: CARTOON_VIDEO_PRESET.watermark,
        videoControl: CARTOON_VIDEO_PRESET.videoControl,
        chain: "animates the generated still (videoStillSha256 must equal stillSha256; mismatches fail publication)",
        submissions: 1,
        seconds: 2,
      },
      delivery: {
        cameras: ["CAM-01", "CAM-02", "CAM-03", "CAM-04"],
        providerSlot: "CAM-01 (animated still)",
        fixtureSlots: ["CAM-02", "CAM-03", "CAM-04"],
        nonBillableFixtureSlots: 3,
        profile: "H.264/yuv420p/24fps/854x480/2s",
      },
      budgetInputs: {
        stillStage: { planId: slot.stillPlanId, modelId: CARTOON_STILL_PRESET.modelId, submissions: 1, creditsCharged: null },
        videoStage: {
          planId: slot.videoPlanId,
          modelId: CARTOON_VIDEO_PRESET.modelId,
          submissions: 1,
          secondsOut: 2,
          creditsCharged: null,
        },
        fixtureSlots: 3,
        ownerMaxCredits: maxCredits,
        priceNote: "Token Plan prices are not stated here; Credits stay UNKNOWN until the provider reports realized charges. Only realized console Credits are billable truth.",
      },
    };
  });

  const plan = {
    mode: "cartoon-few-case-batch",
    preview: true,
    writes: false,
    liveSubmits: 0,
    networkGenerationCalls: 0,
    billableCalls: 0,
    partyId: party,
    deviceId: device,
    channelId: channel,
    cases: 3,
    stillSubmissions: 3,
    videoSubmissions: 3,
    generatedVideoSeconds: 6,
    nonBillableFixtureSlots: 9,
    stillModel: `${CARTOON_STILL_PRESET.modelId} (${CARTOON_STILL_PRESET.region})`,
    videoModel: `${CARTOON_VIDEO_PRESET.modelId} (${CARTOON_VIDEO_PRESET.region}, ${CARTOON_VIDEO_PRESET.videoControl})`,
    videoControls: "2s/480P/silent/no-watermark/prompt_extend false",
    providerPolicy: "Alibaba Singapore Token Plan only (qwen-image-3.0-pro stills, wan3.0-video STANDARD video); never Google/Veo/Imagen",
    ownerMaxCredits: maxCredits,
    budgetGate: "mandatory owner-supplied maximum credit allowance; batch must not run when projected Credits exceed it",
    rows,
  };

  process.stdout.write(`${JSON.stringify(plan)}\n`);
  const outPath = argument("out");
  if (outPath) {
    const resolved = resolve(outPath);
    if (!resolved.startsWith(`${process.cwd()}/`) && resolved !== `${process.cwd()}`) {
      // Keep the artifact inside the repo checkout: portable repo-relative
      // paths only (no /tmp, no ~, no symlinks out of repo).
      fail("--out must resolve inside the current working directory (repo-relative artifact path).");
    }
    writeFileSync(resolved, `${JSON.stringify(plan, null, 2)}\n`);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
