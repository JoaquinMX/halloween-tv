/**
 * Fake-only cloud/emulator generation rehearsal through the PUBLIC contract.
 *
 * Defaults to preview: validates the explicit selection and prints the bounded
 * single-task plan without any network call. With --apply it performs exactly
 * ONE explicitly selected job:
 *
 *   consented synthetic photo -> requestGuestUpload -> PUT bytes ->
 *   completeGuestUpload -> requestGeneration (exactly once; an existing job
 *   is observed, never resubmitted) -> poll the Firestore job doc (observe
 *   only; the real task queue runs the worker) -> read back the manifest and
 *   per-camera usage rows.
 *
 * The plan exercises the P1 consented synthetic-photo source with a bounded
 * single-task guest job: one fake provider submit (CAM-01, normalized to the
 * generated-shape H.264/yuv420p/24fps/854x480/2s silent clip) plus three
 * locally prepared fixture slots (CAM-02..04). Fake selection is logged and
 * usage must reconcile to synthetic zero with provider API calls = 0.
 *
 * Refusals: live providers (only --provider=fake is accepted and an ambient
 * VIDEO_GENERATION_PROVIDER, when set, must also be fake), mixed
 * emulator/cloud targets, and implicit selection (party/device/channel/job
 * are always required). Polling never resubmits: a second request for the
 * same job observes the stored state instead of enqueueing again.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { REQUIRED_CAMERA_IDS } from "../src/config";
import { GUEST_CONSENT_PURPOSE, GUEST_CONSENT_TEXT_VERSION } from "../src/config";
import { usageLedgerId } from "../src/usage";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function fail(message: string): never {
  throw new Error(message);
}

type CallableResult = Record<string, unknown>;

async function callFunction(url: string, data: Record<string, unknown>): Promise<CallableResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(60_000),
  });
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return fail(`Callable ${url} returned a non-JSON response (${response.status}).`);
  }
  if (!response.ok) {
    const error = body.error as { message?: string; status?: string } | undefined;
    return fail(`Callable ${url} failed (${response.status} ${error?.status ?? ""}): ${error?.message ?? JSON.stringify(body)}`);
  }
  const result = body.result ?? body.data;
  if (!result || typeof result !== "object" || Array.isArray(result)) fail(`Callable ${url} returned an invalid response.`);
  return result as CallableResult;
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Locally generated synthetic photo: single-frame JPEG from the native host ffmpeg (never a real user photo). */
function generateSyntheticPhoto(): { path: string; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "halloween-synthetic-photo-"));
  const path = join(directory, "synthetic.jpg");
  const result = spawnSync("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=640x480:rate=1:duration=1",
    "-frames:v", "1", "-q:v", "4", path,
  ], { encoding: "utf8", timeout: 60_000 });
  if (result.error || result.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    fail(`Native host ffmpeg could not generate the synthetic rehearsal photo: ${result.error?.message ?? result.stderr}`);
  }
  return { path, directory };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const target = argument("target");
  if (target !== "cloud" && target !== "emulator") fail("Fake rehearsal requires explicit --target=cloud or --target=emulator.");
  const firestoreEmulator = process.env.FIRESTORE_EMULATOR_HOST;
  const storageEmulator = process.env.STORAGE_EMULATOR_HOST;
  if (Boolean(firestoreEmulator) !== Boolean(storageEmulator)) {
    fail("Refusing mixed emulator/cloud targets: FIRESTORE_EMULATOR_HOST and STORAGE_EMULATOR_HOST must be set together or not at all.");
  }
  if (target === "emulator" && (!firestoreEmulator || !storageEmulator)) {
    fail("Emulator rehearsal requires both FIRESTORE_EMULATOR_HOST and STORAGE_EMULATOR_HOST.");
  }
  if (target === "cloud" && (firestoreEmulator || storageEmulator)) {
    fail("Cloud rehearsal refuses emulator hosts; clear both emulator variables.");
  }

  const providerFlag = argument("provider");
  if (providerFlag !== "fake") fail("Fake rehearsal requires explicit --provider=fake; live providers are refused.");
  const ambientProvider = (process.env.VIDEO_GENERATION_PROVIDER ?? "").trim().toLowerCase();
  if (ambientProvider !== "" && ambientProvider !== "fake") {
    fail(`Fake rehearsal refuses ambient VIDEO_GENERATION_PROVIDER=${ambientProvider}; unset it or set it to fake.`);
  }

  const projectId = argument("project") ?? (target === "cloud" ? undefined : process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT);
  if (!projectId) fail("Rehearsal requires an explicit --project or GCLOUD_PROJECT.");
  if (target === "cloud" && projectId.startsWith("demo-")) fail("A demo project ID cannot be a cloud rehearsal target.");
  const partyId = argument("party");
  const deviceId = argument("device");
  const channelId = argument("channel");
  const jobId = argument("job");
  if (!partyId || !deviceId || !channelId || !jobId) {
    fail("Rehearsal requires explicit --party=, --device=, --channel=, and --job= selection; nothing is inferred.");
  }
  const idempotencyKey = argument("idempotency") ?? jobId;
  const apply = process.argv.includes("--apply");
  const outPath = argument("out");
  const pollTimeoutSeconds = Number(argument("poll-timeout-seconds") ?? 720);
  if (!Number.isSafeInteger(pollTimeoutSeconds) || pollTimeoutSeconds <= 0) fail("--poll-timeout-seconds must be a positive integer.");

  const requestedFunctionsBase = argument("functions-url");
  if (target === "cloud" && !requestedFunctionsBase) fail("Cloud rehearsal requires explicit --functions-url=https://<region>-<project>.cloudfunctions.net.");
  let functionsBase: string | undefined = requestedFunctionsBase;
  if (target === "emulator" && !functionsBase) {
    functionsBase = `http://127.0.0.1:5001/${projectId}/us-central1`;
  }
  if (!functionsBase) fail("Rehearsal requires an explicit --functions-url.");
  const parsed = new URL(`${functionsBase.replace(/\/$/, "")}/requestGeneration`);
  if (target === "cloud" && parsed.protocol !== "https:") fail("Cloud callable endpoint must use HTTPS.");
  if (target === "emulator" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    fail("Emulator rehearsal requires a local callable endpoint; refusing to send rehearsal traffic to a cloud host.");
  }

  const photoOption = argument("photo");
  const plan = {
    mode: "fake-rehearsal",
    preview: !apply,
    target,
    projectId,
    partyId,
    deviceId,
    channelId,
    jobId,
    idempotencyKey,
    provider: "fake",
    presetId: "cheap_demo",
    guestPlan: "consented synthetic photo (requestGuestUpload -> PUT -> completeGuestUpload) then ONE guest-bound requestGeneration (1 fake submit for CAM-01 + 3 fixture slots for CAM-02..CAM-04); poll observes only, never resubmits",
    submits: 1,
  };
  if (!apply) {
    process.stdout.write(`${JSON.stringify({ ...plan, result: "preview", applied: false })}\n`);
    if (outPath) writeFileSync(outPath, `${JSON.stringify({ ...plan, result: "preview", applied: false }, null, 2)}\n`);
    return;
  }

  const photoPath = photoOption ?? generateSyntheticPhoto().path;
  const generatedPhoto = photoOption ? undefined : photoPath;
  let syntheticCleanup: string | undefined;
  if (!photoOption) syntheticCleanup = join(photoPath, "..");
  try {
    if (!existsSync(photoPath)) fail(`Rehearsal photo is missing: ${photoPath}.`);
    const photoBytes = readFileSync(photoPath);
    if (!isJpeg(photoBytes)) fail("Rehearsal photo must be a JPEG image (synthetic single-frame capture).");
    if (photoBytes.byteLength <= 0 || photoBytes.byteLength > 10 * 1024 * 1024) fail("Rehearsal photo size is outside the supported range.");

    const base = functionsBase.replace(/\/$/, "");
    const identity = { partyId, deviceId, channelId };

    const upload = await callFunction(`${base}/requestGuestUpload`, {
      ...identity,
      contentType: "image/jpeg",
      consent: { accepted: true, textVersion: GUEST_CONSENT_TEXT_VERSION, purpose: GUEST_CONSENT_PURPOSE },
    });
    const submissionId = upload.submissionId;
    const uploadUrl = upload.uploadUrl;
    if (typeof submissionId !== "string" || !submissionId || typeof uploadUrl !== "string" || !uploadUrl) {
      fail("requestGuestUpload did not return a submission capability.");
    }
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: photoBytes,
      signal: AbortSignal.timeout(120_000),
    });
    if (!put.ok) fail(`Guest photo PUT failed (${put.status}).`);
    const completed = await callFunction(`${base}/completeGuestUpload`, { ...identity, submissionId });
    if (completed.status !== "eligible") fail(`Guest photo did not reach eligible status (status=${String(completed.status)}).`);
    const sourceHash = completed.sha256;
    if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash)) fail("Completed guest photo has no canonical source hash.");

    const request = await callFunction(`${base}/requestGeneration`, {
      ...identity, jobId, idempotencyKey, presetId: "cheap_demo", guestMediaId: submissionId,
    });
    if (request.created !== true) {
      fail(`Job ${jobId} already exists (created=false); the rehearsal observes the stored job and never resubmits. Re-run without --apply to preview, or select a fresh --job.`);
    }
    const submissions = 1;

    const app = initializeApp({ projectId }, `fake-rehearsal-${randomUUID()}`);
    try {
      const db = getFirestore(app);
      const jobRef = db.doc(`parties/${partyId}/jobs/${jobId}`);
      const deadline = Date.now() + pollTimeoutSeconds * 1000;
      let job: FirebaseFirestore.DocumentData | undefined;
      let polls = 0;
      for (;;) {
        polls += 1;
        const snapshot = await jobRef.get();
        if (!snapshot.exists) fail(`Rehearsal job ${jobId} is missing after requestGeneration accepted it.`);
        job = snapshot.data();
        if (job && ["ready", "failed", "expired", "purged"].includes(String(job.state))) break;
        if (Date.now() >= deadline) fail(`Rehearsal job ${jobId} did not reach a terminal state within ${pollTimeoutSeconds}s (last state=${String(job?.state)}).`);
        await sleep(10_000);
      }
      if (String(job?.state) !== "ready") fail(`Rehearsal job ended in state=${String(job?.state)} (errorCode=${String(job?.errorCode ?? "none")}).`);

      const manifestVersion = Number(job?.manifestVersion);
      const manifestSnapshot = await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get();
      const manifest = manifestSnapshot.data() as {
        version?: number; jobId?: string; channelId?: string; manifestHash?: string;
        cameraClips?: Array<{ cameraId: string; sha256: string; sizeBytes: number; fixture?: boolean }>;
      } | undefined;
      if (!manifestSnapshot.exists || !manifest || manifest.version !== manifestVersion || manifest.jobId !== jobId) {
        fail("Published manifest does not match the rehearsed job.");
      }
      const clips = manifest.cameraClips ?? [];
      if (clips.length !== REQUIRED_CAMERA_IDS.length ||
          REQUIRED_CAMERA_IDS.some((id) => !clips.some((clip) => clip.cameraId === id))) {
        fail("Published manifest does not carry exactly the four registered camera clips.");
      }
      const providerSlots = clips.filter((clip) => !clip.fixture);
      const fixtureSlots = clips.filter((clip) => clip.fixture === true);
      if (providerSlots.length !== 1 || providerSlots[0].cameraId !== "CAM-01") {
        fail(`Guest-bound rehearsal manifest must carry exactly one provider slot (CAM-01); found ${providerSlots.map((clip) => clip.cameraId).join(",") || "none"}.`);
      }
      if (fixtureSlots.length !== 3) fail(`Guest-bound rehearsal manifest must carry three fixture slots; found ${fixtureSlots.length}.`);

      let syntheticZero = 0;
      let providerApiCalls = 0;
      const usage: Array<Record<string, unknown>> = [];
      for (const cameraId of REQUIRED_CAMERA_IDS) {
        const row = (await db.doc(`parties/${partyId}/costLogs/${usageLedgerId(jobId, cameraId as (typeof REQUIRED_CAMERA_IDS)[number])}`).get()).data();
        const ledger = row;
        const taskId = (job?.providerTasks as Record<string, { taskId?: unknown }> | undefined)?.[cameraId]?.taskId;
        const credits = ledger?.credits_charged;
        const isSyntheticZero = typeof taskId === "string" && new RegExp(`^${cameraId}__[a-f0-9]{24}$`).test(taskId) && credits === 0;
        const isFixtureZero = ledger?.fixture === true && taskId == null && (credits === null || credits === 0);
        if (isSyntheticZero || isFixtureZero) syntheticZero += 1;
        else providerApiCalls += 1;
        usage.push({ cameraId, providerTaskId: taskId ?? null, credits: credits ?? null, synthetic: isSyntheticZero || isFixtureZero });
      }

      const log = {
        ...plan,
        preview: false,
        applied: true,
        result: "rehearsed",
        providerSelection: "fake",
        submissions,
        polls,
        jobState: job?.state,
        manifestVersion,
        manifestJobId: manifest.jobId,
        providerSlots: providerSlots.map((clip) => clip.cameraId),
        fixtureSlots: fixtureSlots.map((clip) => clip.cameraId),
        usage,
        syntheticZeroCameras: syntheticZero,
        providerApiCalls,
        fakeCredits: "synthetic zero",
        guestSubmissionId: submissionId,
        guestSourceHash: sourceHash,
        syntheticPhotoSource: photoOption ? `operator-supplied synthetic photo (${photoOption})` : "locally generated single-frame JPEG (native host ffmpeg lavfi testsrc; no real user photo)",
      };
      process.stdout.write(`${JSON.stringify(log)}\n`);
      if (outPath) writeFileSync(outPath, `${JSON.stringify(log, null, 2)}\n`);
      if (providerApiCalls !== 0 || syntheticZero !== REQUIRED_CAMERA_IDS.length) {
        fail(`Rehearsal usage did not reconcile to synthetic zero (syntheticZero=${syntheticZero}, providerApiCalls=${providerApiCalls}).`);
      }
    } finally {
      await deleteApp(app);
    }
  } finally {
    if (syntheticCleanup) rmSync(syntheticCleanup, { recursive: true, force: true });
    if (generatedPhoto && existsSync(generatedPhoto)) rmSync(generatedPhoto, { force: true });
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
