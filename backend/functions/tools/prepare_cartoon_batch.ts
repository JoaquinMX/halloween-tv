/**
 * Cartoon catalog sample-batch planner (cycle-13, preview-only).
 *
 * Builds a concrete owner-reviewable proposed sample batch covering all 16
 * image-backed scenarios WITHOUT submitting any live request or applying any
 * cloud migration:
 *
 *   - one consent-bound portrait per row (guest/operator/host portrait
 *     submission cited, never fabricated mobile consent);
 *   - fixed plan IDs / versions / seeds per scenario;
 *   - 16 still submissions (qwen-image-3.0-pro, Alibaba Singapore) plus
 *     16 two-second video submissions (wan3.0-video STANDARD, 2s/480P/
 *     silent/no-watermark/prompt_extend false): 32 generated video seconds;
 *   - 48 non-billable fixture slots (3 per video row, truthful fixture
 *     provenance, null task ID, null charge);
 *   - separate stage budget inputs (still stage + video stage) and a
 *     mandatory owner-supplied maximum credit allowance; Token Plan prices
 *     are never invented (no per-model price is stated here).
 *
 * Spend safety: this tool has NO live path. It never constructs a provider,
 * never signs reference URLs, never writes Firestore/Storage, and exits
 * nonzero unless `--max-credits` (owner-supplied ceiling) is present.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CARTOON_CATALOG_SCENARIOS, CARTOON_STILL_PRESET, CARTOON_VIDEO_PRESET } from "../src/contracts";
import { loadValidatedCatalogs, resolveFunctionsRoot } from "../src/scenario_catalog";

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
  const portraitPrefix = argument("portrait-prefix") ?? "gsub-cartoon-portrait";

  // Identity linkage: planner slots cross-check the real image-backed
  // catalog records (record ids, versions, reference digests) so the 16
  // rows are bound to hashed catalog bytes, not synthetic slot ids.
  const functionsRoot = resolveFunctionsRoot(resolve(__dirname, "../src"));
  const { catalog } = loadValidatedCatalogs(functionsRoot);
  if (catalog.records.length !== CARTOON_CATALOG_SCENARIOS.length) {
    fail(`Catalog record count (${catalog.records.length}) does not match planner slots (${CARTOON_CATALOG_SCENARIOS.length}).`);
  }
  const rows = CARTOON_CATALOG_SCENARIOS.map((scenario, index) => {
    const record = catalog.records[index];
    if (!record) fail(`Catalog record is missing for planner slot ${scenario.scenarioId}.`);
    const portraitSubmissionId = `${portraitPrefix}-${scenario.scenarioId}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(portraitSubmissionId)) {
      fail(`Derived portrait submission ID is invalid for ${scenario.scenarioId}.`);
    }
    return {
      scenarioId: scenario.scenarioId,
      catalogRecordId: record.id,
      catalogRecordVersion: catalog.version,
      catalogReference: { sourceFilename: record.sourceFilename, sha256: record.sha256, sizeBytes: record.sizeBytes },
      portrait: {
        submissionId: portraitSubmissionId,
        binding: "consent-bound (guest v1/guest_cameo or host host_source_v1/host_source; verified at request/worker/publication)",
        note: "Portrait bytes stay in the consented ingest prefix; only objectPath+hash+consentRevision travel with the job.",
      },
      still: {
        planId: scenario.stillPlanId,
        version: scenario.version,
        seed: scenario.seed,
        modelId: CARTOON_STILL_PRESET.modelId,
        region: CARTOON_STILL_PRESET.region,
        provider: CARTOON_STILL_PRESET.provider,
        inputs: "separately identified portrait reference + scene/style reference",
        submissions: 1,
      },
      video: {
        planId: scenario.videoPlanId,
        version: scenario.version,
        seed: scenario.seed,
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
        stillStage: { planId: scenario.stillPlanId, modelId: CARTOON_STILL_PRESET.modelId, submissions: 1 },
        videoStage: {
          planId: scenario.videoPlanId,
          modelId: CARTOON_VIDEO_PRESET.modelId,
          submissions: 1,
          secondsOut: 2,
        },
        fixtureSlots: 3,
        ownerMaxCredits: maxCredits,
        priceNote: "Token Plan prices are not stated here; only realized console Credits are billable truth.",
      },
    };
  });

  const plan = {
    mode: "cartoon-sample-batch",
    preview: true,
    writes: false,
    liveSubmits: 0,
    networkGenerationCalls: 0,
    billableCalls: 0,
    partyId: party,
    deviceId: device,
    channelId: channel,
    scenarios: 16,
    stillSubmissions: 16,
    videoSubmissions: 16,
    generatedVideoSeconds: 32,
    nonBillableFixtureSlots: 48,
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
