import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { createAlibabaProviderFromEnvironment } from "../src/providers/alibaba";
import { createGenerationServices } from "../src/generation";
import { parseRequestGeneration } from "../src/contracts";

// Cycle-13 note: the cartoon catalog sample batch is planned preview-only
// via tools/prepare_cartoon_batch.ts (16 stills + 16 two-second videos, 32s
// total, 48 fixture slots, mandatory --max-credits gate). That planner never
// submits live requests; this trigger stays cheap_demo-only and its live
// path keeps the explicit budget guard below. Dry-run (default) spends nothing.

function argumentsMap(args: string[]): { flags: Set<string>; values: Record<string, string> } {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const allowedValues = new Set([
    "partyId", "deviceId", "channelId", "jobId", "idempotencyKey", "presetId", "modelId", "region",
    "resolution", "secondsOut", "aspectRatio", "audio", "outputs", "autoUpscale",
  ]);
  const allowedFlags = new Set(["live", "confirm-budget-guard"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const equalsAt = arg.indexOf("=");
    if (equalsAt >= 0) {
      const key = arg.slice(2, equalsAt);
      if (!allowedValues.has(key)) throw new Error(`Unsupported argument: ${key}`);
      values[key] = arg.slice(equalsAt + 1);
    } else if (args[index + 1] && !args[index + 1].startsWith("--")) {
      const key = arg.slice(2);
      if (!allowedValues.has(key)) throw new Error(`Unsupported argument: ${key}`);
      values[key] = args[++index];
    } else {
      const key = arg.slice(2);
      if (!allowedFlags.has(key)) throw new Error(`Unsupported flag: ${key}`);
      flags.add(key);
    }
  }
  return { flags, values };
}

function requestFrom(values: Record<string, string>) {
  return parseRequestGeneration({
    partyId: values.partyId ?? process.env.PARTY_ID,
    deviceId: values.deviceId ?? process.env.DEVICE_ID,
    channelId: values.channelId ?? process.env.CHANNEL_ID,
    jobId: values.jobId,
    idempotencyKey: values.idempotencyKey ?? values.jobId,
    presetId: values.presetId ?? "cheap_demo",
    ...(values.modelId ? { modelId: values.modelId } : {}),
    ...(values.region ? { region: values.region } : {}),
    ...(values.resolution ? { resolution: values.resolution } : {}),
    ...(values.secondsOut ? { secondsOut: Number(values.secondsOut) } : {}),
    ...(values.aspectRatio ? { aspectRatio: values.aspectRatio } : {}),
    ...(values.audio ? { audio: values.audio === "true" } : {}),
    ...(values.outputs ? { outputs: Number(values.outputs) } : {}),
    ...(values.autoUpscale ? { autoUpscale: values.autoUpscale === "true" } : {}),
  });
}

async function main(): Promise<void> {
  const { flags, values } = argumentsMap(process.argv.slice(2));
  const input = requestFrom(values);
  const live = flags.has("live");
  if (!live) {
    process.stdout.write(`${JSON.stringify({
      mode: "dry-run",
      writes: false,
      estimatedBillableCalls: 4,
      estimatedSecondsOut: 8,
      request: input,
    })}\n`);
    return;
  }
  if (!flags.has("confirm-budget-guard") || process.env.GENERATION_OWNER_CONFIRMATION !== "I_CONFIRM_CHEAP_DEMO_BUDGET") {
    throw new Error("Live trigger requires --confirm-budget-guard and GENERATION_OWNER_CONFIRMATION=I_CONFIRM_CHEAP_DEMO_BUDGET.");
  }
  if ((process.env.VIDEO_GENERATION_PROVIDER ?? "").toLowerCase() !== "alibaba") {
    throw new Error("Live trigger requires VIDEO_GENERATION_PROVIDER=alibaba; it will not substitute a provider.");
  }
  const app = initializeApp({
    projectId: process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT,
    storageBucket: process.env.STORAGE_BUCKET,
  }, `request-generation-${Date.now()}`);
  try {
    const services = createGenerationServices({
      db: getFirestore(app),
      bucket: getStorage(app).bucket(),
      provider: createAlibabaProviderFromEnvironment(),
    });
    const created = await services.requestGeneration(input);
    const result = created.created || ["queued", "running"].includes(created.state)
      ? await services.runGeneration({
        partyId: input.partyId,
        deviceId: input.deviceId,
        channelId: input.channelId,
        jobId: input.jobId,
        idempotencyKey: input.idempotencyKey,
      })
      : { jobId: created.jobId, state: created.state, manifestVersion: created.manifestVersion };
    process.stdout.write(`${JSON.stringify({ mode: "live", request: created, result })}\n`);
  } finally {
    await deleteApp(app);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
