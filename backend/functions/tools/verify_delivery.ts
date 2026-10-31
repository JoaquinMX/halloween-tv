/**
 * Operator delivery rehearsal through the public callable contract.
 *
 * Flow: getDeliveryUrls -> download and independently hash all four clips ->
 * durably retain them -> ACK the exact camera hashes -> repeat the ACK ->
 * inspect the persisted ACK/job and object absence -> re-read the retained
 * files after purge.
 *
 * Cloud mode talks to deployed HTTPS callables only. Emulator mode is an
 * explicit test substitute: URL signing and TLS are provided by either a
 * local Functions emulator or the tool's own local callable-compatible server
 * (real delivery service, real Firestore/Storage emulators, emulator signer).
 * The substitute is never reachable from cloud mode.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AddressInfo } from "node:net";
import type { Bucket } from "@google-cloud/storage";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { ackIdempotencyKey, BackendError, canonicalManifestHash, DeliveryManifest } from "../src/contracts";
import { REQUIRED_CAMERA_IDS } from "../src/config";
import { createDeliveryServices } from "../src/delivery";

const ACCEPTED_VIDEO_PROFILES = [
  { width: 854, height: 480, label: "normalized delivery profile" },
  { width: 960, height: 540, label: "repository fixture profile" },
] as const;

type CallableClip = { cameraId: string; sha256: string; url: string; expiresAt: string };
type CallableResult = Record<string, unknown>;

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function fail(message: string): never {
  throw new Error(message);
}

function emulatorHost(value: string): string {
  return value.startsWith("http://") || value.startsWith("https://") ? value : `http://${value}`;
}

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
  if (!result || typeof result !== "object" || Array.isArray(result)) return fail(`Callable ${url} returned an invalid response.`);
  return result as CallableResult;
}

function probeVideo(path: string, ffprobePath: string): void {
  const result = spawnSync(ffprobePath, [
    "-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=codec_name,pix_fmt,r_frame_rate,width,height:format=duration", "-of", "json", path,
  ], { encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) {
    fail(`Retained clip is not playable by ffprobe (${path}): ${result.stderr || result.error?.message || "probe failed"}`);
  }
  const metadata = JSON.parse(result.stdout) as {
    streams?: Array<{ codec_name?: string; pix_fmt?: string; r_frame_rate?: string; width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const video = metadata.streams?.[0];
  const durationMs = Math.round(Number(metadata.format?.duration) * 1000);
  const profile = ACCEPTED_VIDEO_PROFILES.find((candidate) => candidate.width === video?.width && candidate.height === video?.height);
  if (video?.codec_name !== "h264" || video.pix_fmt !== "yuv420p" || video.r_frame_rate !== "24/1" || durationMs !== 2000 || !profile) {
    fail(`Retained clip failed the delivery playback check (h264/yuv420p/24fps/2s at 854x480 or 960x540): ${path}`);
  }
}

/** Test-only callable substitute: the real delivery service behind a local HTTP callable envelope. */
function startCallableSubstitute(
  db: FirebaseFirestore.Firestore,
  bucket: Bucket,
  storageBase: string,
  bucketName: string,
): Promise<{ url: string; server: Server }> {
  const services = createDeliveryServices({
    db,
    bucket,
    signReadUrl: async (file) => `${storageBase}/v0/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(file.name)}?alt=media`,
  });
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    let payload: { data?: unknown };
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: unknown };
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "Malformed callable payload." } }));
      return;
    }
    const path = (request.url ?? "").split("?")[0];
    try {
      const result = path.endsWith("/getDeliveryUrls")
        ? await services.getDeliveryUrls(payload.data)
        : path.endsWith("/acknowledgeDelivery")
          ? await services.acknowledgeDelivery(payload.data)
          : fail(`Unknown callable path ${path}.`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result }));
    } catch (error) {
      const code = error instanceof BackendError ? error.errorCode : "INTERNAL";
      response.writeHead(code === "INVALID_ARGUMENT" ? 400 : 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { status: code, message: error instanceof Error ? error.message : "failed" } }));
    }
  };
  const server = createServer((request, response) => { void handler(request, response); });
  return new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolveServer({ url: `http://127.0.0.1:${address.port}`, server });
    });
  });
}

async function retainClip(directory: string, cameraId: string, bytes: Buffer): Promise<string> {
  const temporary = join(directory, `.${cameraId}-${randomUUID()}.tmp`);
  const retained = join(directory, `${cameraId}.mp4`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  await rename(temporary, retained);
  return retained;
}

async function main(): Promise<void> {
  const target = argument("target");
  if (target !== "emulator" && target !== "cloud") fail("Delivery verification requires explicit --target=emulator or --target=cloud.");
  const observeOnly = process.argv.includes("--observe-only");
  if (!observeOnly && !process.argv.includes("--ack-and-purge")) {
    fail("Delivery verification requires explicit --ack-and-purge (ACK deletes the four delivery objects) or --observe-only (read-back without ACKing).");
  }
  if (observeOnly && process.argv.includes("--ack-and-purge")) {
    fail("Delivery verification refuses --observe-only together with --ack-and-purge; the observer never preempts the TV download or purge.");
  }
  const emulatorServiceSubstitute = process.argv.includes("--emulator-service-substitute");
  const firestoreEmulator = process.env.FIRESTORE_EMULATOR_HOST;
  const storageEmulator = process.env.STORAGE_EMULATOR_HOST;
  if (Boolean(firestoreEmulator) !== Boolean(storageEmulator)) {
    fail("Refusing mixed emulator configuration: FIRESTORE_EMULATOR_HOST and STORAGE_EMULATOR_HOST must be set together or not at all.");
  }
  if (target === "emulator") {
    if (!firestoreEmulator || !storageEmulator) fail("Emulator verification requires both FIRESTORE_EMULATOR_HOST and STORAGE_EMULATOR_HOST.");
    if (!emulatorServiceSubstitute) fail("Emulator URL signing/TLS is not production-equivalent; explicitly select --emulator-service-substitute for the test-only signer and download handling.");
  } else {
    if (firestoreEmulator || storageEmulator) fail("Cloud verification refuses emulator hosts; clear both emulator variables.");
    if (emulatorServiceSubstitute) fail("The emulator signing/TLS substitute is forbidden for cloud verification.");
  }

  const projectId = argument("project") ?? (target === "cloud" ? undefined : process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT);
  if (!projectId) fail("Verification requires an explicit --project or GCLOUD_PROJECT.");
  if (target === "cloud" && projectId.startsWith("demo-")) fail("A demo project ID cannot be a cloud target.");
  if (target === "cloud" && (process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT) &&
      projectId !== (process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT)) {
    fail("Explicit --project disagrees with the ambient Firebase project.");
  }
  const bucketName = argument("bucket") ?? process.env.STORAGE_BUCKET;
  if (!bucketName) fail("Verification requires an explicit --bucket or STORAGE_BUCKET.");
  if (bucketName.startsWith("gs://") || /\s/.test(bucketName)) fail("Bucket must be a bare bucket name.");
  if (target === "cloud" && process.env.STORAGE_BUCKET && bucketName !== process.env.STORAGE_BUCKET) {
    fail("--bucket disagrees with STORAGE_BUCKET for this cloud target.");
  }
  const partyId = argument("party");
  const deviceId = argument("device");
  const channelId = argument("channel");
  if (!partyId || !deviceId || !channelId) fail("Verification requires explicit --party=..., --device=..., and --channel=... registration IDs.");
  const outputDirectory = resolve(argument("output-dir") ?? join(process.cwd(), "delivery-verification", `${partyId}-${deviceId}`));
  const ffprobePath = nativeFfprobePath();
/** Native host ffprobe for retained-clip checks. runtime/bin Linux binaries
 * are never executed on a foreign host: only FFPROBE_NATIVE_PATH or PATH
 * `ffprobe` is used unless this IS the linux-x64 execution host. */
function nativeFfprobePath(): string {
  if (process.env.FFPROBE_NATIVE_PATH) return process.env.FFPROBE_NATIVE_PATH;
  if (process.platform === "linux" && process.arch === "x64") {
    const packaged = resolve(process.cwd(), "runtime", "bin", "ffprobe");
    if (existsSync(packaged)) return packaged;
    if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  }
  return "ffprobe";
}

  const requestedFunctionsBase = argument("functions-url");
  if (target === "cloud" && !requestedFunctionsBase) fail("Cloud verification requires explicit --functions-url=https://<region>-<project>.cloudfunctions.net.");
  let functionsBase = requestedFunctionsBase;
  if (target === "emulator") {
    functionsBase = functionsBase ?? `${emulatorHost(process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5001")}/${projectId}/us-central1`;
  }
  try {
    const parsed = new URL(`${functionsBase!.replace(/\/$/, "")}/getDeliveryUrls`);
    if (target === "cloud" && parsed.protocol !== "https:") fail("Cloud callable endpoint must use HTTPS.");
    if (target === "emulator" && !["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(parsed.hostname)) {
      fail("Emulator verification requires a local callable endpoint; refusing to send emulator ACKs to a cloud host.");
    }
  } catch (error) {
    if (error instanceof Error && /callable endpoint|local callable/.test(error.message)) throw error;
    fail("Functions callable base URL is invalid.");
  }

  const app = initializeApp({ projectId, storageBucket: bucketName }, `verify-delivery-${randomUUID()}`);
  let substitute: { url: string; server: Server } | undefined;
  try {
    const db = getFirestore(app);
    const bucket = getStorage(app).bucket(bucketName);
    let callableBase = functionsBase!;
    if (target === "emulator" && !requestedFunctionsBase) {
      substitute = await startCallableSubstitute(db, bucket, emulatorHost(storageEmulator!), bucketName);
      callableBase = substitute.url;
    }
    const base = callableBase.replace(/\/$/, "");

    const delivery = await callFunction(`${base}/getDeliveryUrls`, { partyId, deviceId, channelId });
    if (!Number.isSafeInteger(delivery.manifestVersion) || Number(delivery.manifestVersion) < 1 ||
        typeof delivery.manifestHash !== "string" || !Array.isArray(delivery.clips)) {
      fail("getDeliveryUrls returned an incomplete manifest projection.");
    }
    const manifestSnapshot = await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get();
    const manifest = manifestSnapshot.data() as DeliveryManifest | undefined;
    if (!manifest) fail("Published current manifest is missing after the public callable returned URLs.");
    const manifestHash = canonicalManifestHash(manifest);
    if (manifest.version !== delivery.manifestVersion || manifestHash !== delivery.manifestHash) {
      fail("Public callable manifest projection does not match the stored canonical manifest.");
    }
    const manifestExpiry = Date.parse(manifest.expiresAt);
    if (!Number.isFinite(manifestExpiry) || manifestExpiry <= Date.now()) fail("Published manifest is already expired.");

    const clips = delivery.clips as CallableClip[];
    if (clips.length !== REQUIRED_CAMERA_IDS.length || REQUIRED_CAMERA_IDS.some((id) => !clips.some((clip) => clip.cameraId === id))) {
      fail("Public callable did not return exactly the four registered camera clips.");
    }

    await mkdir(outputDirectory, { recursive: true });
    const emulatorStorageBase = target === "emulator" ? emulatorHost(storageEmulator!) : undefined;
    const hashes: Record<string, string> = {};
    const retainedFiles: Record<string, string> = {};
    for (const item of clips) {
      const canonical = manifest.cameraClips.find((clip) => clip.cameraId === item.cameraId);
      if (!canonical || item.sha256 !== canonical.sha256 || !item.url || !Number.isFinite(Date.parse(item.expiresAt))) {
        fail(`Public URL metadata does not match the manifest for ${item.cameraId}.`);
      }
      if (Date.parse(item.expiresAt) <= Date.now()) fail(`Delivery URL already expired for ${item.cameraId}.`);
      let downloadUrl = item.url;
      const headers: Record<string, string> = {};
      if (target === "emulator") {
        if (new URL(item.url).pathname.startsWith("/v0/b/")) {
          // Emulator REST URL already; the Storage emulator has no TLS or signing.
          downloadUrl = `${emulatorStorageBase}/v0/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(canonical.objectPath)}?alt=media`;
        }
        headers.Authorization = "Bearer owner";
      } else if (new URL(item.url).protocol !== "https:") {
        fail(`Cloud delivery URL must use HTTPS for ${item.cameraId}.`);
      }
      const response = await fetch(downloadUrl, { headers, redirect: "follow", signal: AbortSignal.timeout(60_000) });
      if (!response.ok) fail(`Clip download failed for ${item.cameraId} (${response.status}).`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== canonical.sha256 || bytes.byteLength !== canonical.sizeBytes) {
        fail(`Downloaded bytes failed independent hash/size verification for ${item.cameraId}.`);
      }
      const retained = await retainClip(outputDirectory, item.cameraId, bytes);
      probeVideo(retained, ffprobePath);
      hashes[item.cameraId] = hash;
      retainedFiles[item.cameraId] = retained;
    }

    const ackInput = { partyId, deviceId, channelId, manifestVersion: manifest.version, clipHashes: hashes };
    const expectedAckId = ackIdempotencyKey(deviceId, channelId, manifest.version);
    if (observeOnly) {
      // Observer/read-back mode: no ACK is sent, so the TV download and purge
      // are never preempted. Reads the persisted ACK/job state as the TV (or
      // a prior operator purge) left it, and re-checks retained local bytes.
      const [ackSnapshot, jobSnapshot] = await Promise.all([
        db.doc(`parties/${partyId}/deliveryAcks/${expectedAckId}`).get(),
        db.doc(`parties/${partyId}/jobs/${manifest.jobId}`).get(),
      ]);
      const persistedAck = ackSnapshot.exists ? ackSnapshot.data() : undefined;
      const observedJob = jobSnapshot.exists ? jobSnapshot.data() : undefined;
      for (const clip of manifest.cameraClips) {
        const retained = await readFile(retainedFiles[clip.cameraId]);
        if (retained.byteLength !== clip.sizeBytes || createHash("sha256").update(retained).digest("hex") !== clip.sha256) {
          fail(`Locally retained clip is unreadable or corrupt after read-back: ${clip.cameraId}`);
        }
      }
      process.stdout.write(`${JSON.stringify({
        verification: "observed",
        target,
        projectId,
        bucket: bucketName,
        partyId,
        deviceId,
        channelId,
        manifestVersion: manifest.version,
        manifestHash,
        downloadedCameraIds: REQUIRED_CAMERA_IDS,
        independentlyHashed: true,
        ffprobeVerifiedPlayable: true,
        retainedDirectory: outputDirectory,
        retainedFiles,
        observerOnly: true,
        ackSent: false,
        persistedAck: persistedAck ? { ackId: expectedAckId, manifestVersion: persistedAck.manifestVersion, deviceId: persistedAck.deviceId } : null,
        jobState: observedJob?.state ?? null,
        jobDeliveryAckId: observedJob?.deliveryAckId ?? null,
        urlMode: target === "emulator"
          ? (requestedFunctionsBase ? "local callable endpoint with emulator signer (test-only)" : "local callable substitute with emulator signer (test-only)")
          : "public Firebase callable and signed HTTPS URLs",
      })}\n`);
      return;
    }
    const firstAck = await callFunction(`${base}/acknowledgeDelivery`, ackInput);
    const repeatedAck = await callFunction(`${base}/acknowledgeDelivery`, ackInput);
    if (firstAck.ackId !== expectedAckId || repeatedAck.ackId !== expectedAckId || firstAck.purged !== true || repeatedAck.purged !== true) {
      fail("ACK response did not confirm the exact idempotent manifest ACK and purge.");
    }
    const [ackSnapshot, jobSnapshot] = await Promise.all([
      db.doc(`parties/${partyId}/deliveryAcks/${expectedAckId}`).get(),
      db.doc(`parties/${partyId}/jobs/${manifest.jobId}`).get(),
    ]);
    const ack = ackSnapshot.data();
    const job = jobSnapshot.data();
    if (!ackSnapshot.exists || ack?.manifestVersion !== manifest.version || ack?.deviceId !== deviceId) {
      fail("Persisted ACK document does not match the callable result.");
    }
    if (job?.state !== "purged" || job?.deliveryAckId !== expectedAckId) {
      fail(`Persisted job state does not record the purge (state=${String(job?.state)}, ackId=${String(job?.deliveryAckId)}).`);
    }
    for (const clip of manifest.cameraClips) {
      if ((await bucket.file(clip.objectPath).exists())[0]) fail(`ACK left delivery object present: ${clip.objectPath}`);
      const retained = await readFile(retainedFiles[clip.cameraId]);
      if (retained.byteLength !== clip.sizeBytes || createHash("sha256").update(retained).digest("hex") !== clip.sha256) {
        fail(`Locally retained clip is unreadable or corrupt after purge: ${clip.cameraId}`);
      }
    }

    process.stdout.write(`${JSON.stringify({
      verification: "passed",
      target,
      projectId,
      bucket: bucketName,
      partyId,
      deviceId,
      channelId,
      manifestVersion: manifest.version,
      manifestHash,
      downloadedCameraIds: REQUIRED_CAMERA_IDS,
      independentlyHashed: true,
      ffprobeVerifiedPlayable: true,
      retainedDirectory: outputDirectory,
      retainedFiles,
      ackId: expectedAckId,
      repeatAckIdempotent: true,
      jobState: job.state,
      deliveryObjectsAbsent: true,
      retainedFilesReadableAfterPurge: true,
      urlMode: target === "emulator"
        ? (requestedFunctionsBase ? "local callable endpoint with emulator signer (test-only)" : "local callable substitute with emulator signer (test-only)")
        : "public Firebase callable and signed HTTPS URLs",
    })}\n`);
  } finally {
    if (substitute) await new Promise<void>((closed) => substitute!.server.close(() => closed()));
    await deleteApp(app);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
