/**
 * Safe pilot fixture seeder. It writes real playable fixture MP4 bytes only;
 * no generation provider is constructed or called.
 *
 * Consent guarantee: this seeder NEVER creates guest consent. It writes only
 * party/device/channel/manifest/job fixture docs plus delivery bytes. It
 * never writes to the guestMedia collection, never records consent text or
 * purpose, and never mints provenance. The CREATES_GUEST_CONSENT export is
 * asserted false by the consent-migration test suite.
 *
 * Default is a read-only preview. Cloud writes require --target=cloud,
 * --project=..., --bucket=..., and --apply, plus operator ADC/IAM.
 */
import { createHash, randomUUID } from "node:crypto";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Bucket } from "@google-cloud/storage";
import { REQUIRED_CAMERA_IDS, SCHEMA_VERSION } from "../src/config";

const DEFAULT_PARTY = "pilot";
const DEFAULT_DEVICE = "tv-pilot";
const DEFAULT_CHANNEL = "haunted_surveillance";
const PILOT_JOB_ID = "pilot-fixture-v1";
const SEED_KEY = "pilot-fixture-v1";
const RETENTION_MS = 24 * 60 * 60 * 1000;
type Target = "emulator" | "cloud";

/** This seeder never creates guest consent (asserted by tests). */
export const CREATES_GUEST_CONSENT = false as const;

/** Firestore collections this seeder may write. guestMedia is never in scope. */
export const SEED_PILOT_WRITABLE_COLLECTIONS = [
  "parties",
  "devices",
  "channels",
  "manifests",
  "jobs",
] as const;
type Fixture = { cameraId: (typeof REQUIRED_CAMERA_IDS)[number]; sha256: string; sizeBytes: number; durationMs: number; path: string };

interface Options {
  target?: Target;
  project?: string;
  bucket?: string;
  party: string;
  device: string;
  channel: string;
  apply: boolean;
}

function fail(message: string): never { throw new Error(message); }

function parseOptions(args: string[]): Options {
  const values: Record<string, string> = {};
  let apply = false;
  for (const arg of args) {
    if (arg === "--apply") { apply = true; continue; }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) fail(`Unknown seed argument ${arg}; use --name=value and opt into writes with --apply.`);
    values[match[1]] = match[2];
  }
  const target = values.target as Target | undefined;
  if (target !== "emulator" && target !== "cloud") fail("Seed requires explicit --target=emulator or --target=cloud.");
  const party = values.party ?? process.env.PILOT_PARTY_ID ?? DEFAULT_PARTY;
  const device = values.device ?? process.env.PILOT_DEVICE_ID ?? DEFAULT_DEVICE;
  const channel = values.channel ?? process.env.PILOT_CHANNEL_ID ?? DEFAULT_CHANNEL;
  for (const [label, id] of [["party", party], ["device", device], ["channel", channel]]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) fail(`${label} ID is invalid.`);
  }
  return { target, project: values.project, bucket: values.bucket, party, device, channel, apply };
}

function selectEnvironment(options: Options): { projectId: string; bucketName: string } {
  const firestoreEmulator = process.env.FIRESTORE_EMULATOR_HOST;
  const storageEmulator = process.env.STORAGE_EMULATOR_HOST;
  if (Boolean(firestoreEmulator) !== Boolean(storageEmulator)) {
    fail("Refusing a partial emulator target: set both FIRESTORE_EMULATOR_HOST and STORAGE_EMULATOR_HOST, or neither.");
  }
  if (options.target === "emulator") {
    if (!firestoreEmulator || !storageEmulator) fail("Emulator seeding requires both FIRESTORE_EMULATOR_HOST and STORAGE_EMULATOR_HOST.");
    if (options.apply && options.project && !options.project.startsWith("demo-")) {
      fail("Emulator apply requires a demo project ID; cloud project IDs must use the explicit cloud path.");
    }
    const projectId = options.project ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "demo-halloween-tv";
    const bucketName = options.bucket ?? process.env.STORAGE_BUCKET;
    if (!bucketName) fail("Emulator seeding requires explicit STORAGE_BUCKET or --bucket.");
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) fail("Firebase project ID is invalid.");
    if (bucketName.startsWith("gs://") || /\s/.test(bucketName)) fail("Storage bucket must be a bucket name, without gs:// or whitespace.");
    return { projectId, bucketName };
  }
  if (firestoreEmulator || storageEmulator) fail("Cloud seeding refuses emulator environment variables; clear both before selecting a cloud target.");
  if (!options.project || !options.bucket) fail("Cloud seed preview/apply requires explicit --project=PROJECT and --bucket=BUCKET flags.");
  if (options.party === DEFAULT_PARTY || options.device === DEFAULT_DEVICE) {
    fail("Cloud seeding refuses the guessable pilot defaults: provisioned party/device IDs are the TV authorization credential, so a real deployment must use explicit unguessable --party/--device values (or PILOT_PARTY_ID/PILOT_DEVICE_ID).");
  }
  const ambientProject = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (ambientProject && ambientProject !== options.project) fail("Explicit --project disagrees with GCLOUD_PROJECT/GOOGLE_CLOUD_PROJECT; clear the conflicting target.");
  if (process.env.STORAGE_BUCKET && process.env.STORAGE_BUCKET !== options.bucket) {
    fail("Explicit --bucket disagrees with STORAGE_BUCKET; clear the conflicting configuration before cloud seeding.");
  }
  if (options.project.startsWith("demo-")) fail("Cloud seed target cannot use a demo project ID.");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project)) fail("Firebase project ID is invalid.");
  if (options.bucket.startsWith("gs://") || /\s/.test(options.bucket)) fail("Storage bucket must be a bucket name, without gs:// or whitespace.");
  return { projectId: options.project, bucketName: options.bucket };
}

async function loadFixtures(): Promise<Fixture[]> {
  const runtimeDirectory = resolve(process.cwd(), "runtime/fixtures");
  const assetsDirectory = resolve(process.cwd(), "../../apps/tv_app/assets");
  const fixtureDirectory = existsSync(join(runtimeDirectory, "fixture_manifest.json")) ? runtimeDirectory : assetsDirectory;
  const manifestPath = join(fixtureDirectory, "fixture_manifest.json");
  if (!existsSync(manifestPath)) fail("Playable fixture manifest is missing; run npm run runtime:prepare or run from the repository checkout.");
  const source = JSON.parse(await readFile(manifestPath, "utf8")) as { clips?: Array<{ cameraId: string; sha256: string; sizeBytes: number; durationMs: number }> };
  if (!Array.isArray(source.clips) || source.clips.length !== REQUIRED_CAMERA_IDS.length) fail("Fixture manifest must list exactly four clips.");
  const result: Fixture[] = [];
  for (const cameraId of REQUIRED_CAMERA_IDS) {
    const entry = source.clips.find((clip) => clip.cameraId === cameraId);
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.sizeBytes) || entry.durationMs !== 2000) {
      fail(`Fixture metadata is invalid for ${cameraId}.`);
    }
    const path = join(fixtureDirectory, `cam${cameraId.slice(-2).toLowerCase()}.mp4`);
    const bytes = await readFile(path);
    if (bytes.byteLength !== entry.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256 || bytes.toString("ascii", 4, 8) !== "ftyp") {
      fail(`Fixture bytes are not the playable manifest content for ${cameraId}.`);
    }
    result.push({ cameraId, sha256: entry.sha256, sizeBytes: bytes.byteLength, durationMs: entry.durationMs, path });
  }
  return result;
}

function refs(db: FirebaseFirestore.Firestore, partyId: string, deviceId: string, channelId: string) {
  return {
    party: db.doc(`parties/${partyId}`),
    device: db.doc(`parties/${partyId}/devices/${deviceId}`),
    channel: db.doc(`parties/${partyId}/channels/${channelId}`),
    manifest: db.doc(`parties/${partyId}/manifests/current_${channelId}`),
    job: db.doc(`parties/${partyId}/jobs/${PILOT_JOB_ID}`),
  };
}

function objectPath(partyId: string, channelId: string, version: number, cameraId: string): string {
  return `parties/${partyId}/channels/${channelId}/delivery/${version}/${cameraId}.mp4`;
}

function sameManifest(data: FirebaseFirestore.DocumentData, options: Options, clips: Fixture[]): boolean {
  return data.partyId === options.party && data.channelId === options.channel && data.version === 1 &&
    data.jobId === PILOT_JOB_ID && data.schemaVersion === SCHEMA_VERSION && Boolean(data.createdAt) &&
    typeof data.expiresAt === "string" && Number.isFinite(Date.parse(data.expiresAt)) && Array.isArray(data.cameraClips) &&
    data.cameraClips.length === clips.length && clips.every((clip) => {
      const actual = data.cameraClips.find((item: { cameraId?: string }) => item.cameraId === clip.cameraId);
      return actual?.objectPath === objectPath(options.party, options.channel, 1, clip.cameraId) &&
        actual.sha256 === clip.sha256 && actual.sizeBytes === clip.sizeBytes && actual.durationMs === clip.durationMs &&
        actual.expiresAt === data.expiresAt;
    });
}

async function validateExisting(
  db: FirebaseFirestore.Firestore,
  bucket: Bucket,
  options: Options,
  clips: Fixture[],
): Promise<"new" | "already-seeded" | "already-purged"> {
  const refsForSeed = refs(db, options.party, options.device, options.channel);
  const [party, device, channel, manifest, job] = await Promise.all([
    refsForSeed.party.get(), refsForSeed.device.get(), refsForSeed.channel.get(), refsForSeed.manifest.get(), refsForSeed.job.get(),
  ]);
  if (party.exists && (party.data()?.status !== "active" || party.data()?.activeChannelId !== options.channel)) fail("Existing pilot party is unrelated or inactive; refusing to change it.");
  if (device.exists && (device.data()?.status !== "active" || device.data()?.partyId !== options.party || device.data()?.deviceId !== options.device)) fail("Existing pilot device is unrelated or inactive; refusing to change it.");
  if (channel.exists && (channel.data()?.status !== "active" || channel.data()?.partyId !== options.party || channel.data()?.channelId !== options.channel)) fail("Existing pilot channel is unrelated or inactive; refusing to change it.");

  if (manifest.exists) {
    const data = manifest.data()!;
    if (data.version !== 1) fail(`Current manifest version ${String(data.version)} is newer or unrelated; the pilot seeder never replaces it.`);
    const jobData = job.data();
    const expectedPaths = clips.map((clip) => objectPath(options.party, options.channel, 1, clip.cameraId));
    if (!sameManifest(data, options, clips) || !job.exists || jobData?.jobId !== PILOT_JOB_ID || jobData?.idempotencyKey !== SEED_KEY ||
        jobData.partyId !== options.party || jobData.deviceId !== options.device || jobData.channelId !== options.channel ||
        jobData.manifestVersion !== 1 || !jobData.createdAt || !(jobData.expiresAt instanceof Timestamp) ||
        jobData.expiresAt.toDate().toISOString() !== data.expiresAt ||
        JSON.stringify(jobData.deliveryPaths) !== JSON.stringify(expectedPaths) ||
        !["ready", "delivering", "purged"].includes(String(jobData.state))) {
      fail("Current manifest or pilot job is not the exact seeded fixture version; refusing overwrite.");
    }
    const state = String(job.data()?.state ?? "");
    const exists = await Promise.all(clips.map((clip) => bucket.file(objectPath(options.party, options.channel, 1, clip.cameraId)).exists().then(([value]) => value)));
    if (state === "purged") {
      if (exists.some(Boolean)) fail("Purged pilot job has unexpected objects; refusing silent version resurrection.");
      return "already-purged";
    }
    if (!["ready", "delivering"].includes(state) || exists.some((value) => !value)) {
      fail(`Seeded pilot state ${state || "missing"} has incomplete storage; refusing repair or resurrection.`);
    }
    for (const clip of clips) {
      const file = bucket.file(objectPath(options.party, options.channel, 1, clip.cameraId));
      const [[bytes], [metadata]] = await Promise.all([file.download(), file.getMetadata()]);
      if (bytes.byteLength !== clip.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== clip.sha256) {
        fail(`Existing pilot object content changed for ${clip.cameraId}; refusing overwrite.`);
      }
      const objectMetadata = metadata.metadata ?? {};
      const customTime = (metadata as { customTime?: string }).customTime;
      // The Storage emulator does not persist customTime; the sweeper and the
      // bucket lifecycle backstop both read the custom metadata expiresAt, so
      // an absent customTime is tolerated only for the emulator target. Cloud
      // objects must carry the customTime used by daysSinceCustomTime.
      if (customTime !== undefined ? customTime !== data.expiresAt : options.target !== "emulator") {
        fail(`Existing pilot lifecycle/content metadata changed for ${clip.cameraId}; refusing overwrite.`);
      }
      if (metadata.contentType !== "video/mp4" ||
          objectMetadata.expiresAt !== data.expiresAt || objectMetadata.jobId !== PILOT_JOB_ID ||
          objectMetadata.partyId !== options.party || objectMetadata.channelId !== options.channel ||
          objectMetadata.cameraId !== clip.cameraId || objectMetadata.purpose !== "delivery" || objectMetadata.sha256 !== clip.sha256) {
        fail(`Existing pilot lifecycle/content metadata changed for ${clip.cameraId}; refusing overwrite.`);
      }
    }
    return "already-seeded";
  }
  if (job.exists) {
    const orphan = job.data()!;
    if (String(orphan.state ?? "") === "purged" && orphan.jobId === PILOT_JOB_ID &&
        orphan.partyId === options.party && orphan.deviceId === options.device && orphan.channelId === options.channel) {
      const paths = clips.map((clip) => objectPath(options.party, options.channel, 1, clip.cameraId));
      const objects = await Promise.all(paths.map((path) => bucket.file(path).exists().then(([value]) => value)));
      if (objects.some(Boolean)) fail("Purged pilot job has unexpected objects; refusing silent version resurrection.");
      return "already-purged";
    }
    fail("Pilot seed job exists without its current manifest; refusing to attach or overwrite it.");
  }
  const paths = clips.map((clip) => objectPath(options.party, options.channel, 1, clip.cameraId));
  const objects = await Promise.all(paths.map((path) => bucket.file(path).exists().then(([value]) => value)));
  if (objects.some(Boolean)) fail("Pilot delivery object path is already occupied without the seed manifest; refusing overwrite.");
  return "new";
}

async function applySeed(
  db: FirebaseFirestore.Firestore,
  bucket: Bucket,
  options: Options,
  clips: Fixture[],
): Promise<void> {
  const expiresAt = new Date(Date.now() + RETENTION_MS).toISOString();
  const uploaded: string[] = [];
  let commitAttempted = false;
  try {
    for (const clip of clips) {
      const path = objectPath(options.party, options.channel, 1, clip.cameraId);
      const bytes = await readFile(clip.path);
      await bucket.file(path).save(bytes, {
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          contentType: "video/mp4",
          customTime: expiresAt,
          metadata: {
            expiresAt,
            jobId: PILOT_JOB_ID,
            partyId: options.party,
            channelId: options.channel,
            cameraId: clip.cameraId,
            purpose: "delivery",
            sha256: clip.sha256,
          },
        },
      });
      uploaded.push(path);
    }
    const refsForSeed = refs(db, options.party, options.device, options.channel);
    const timestamp = FieldValue.serverTimestamp();
    const expiresTimestamp = Timestamp.fromDate(new Date(expiresAt));
    const cameraClips = clips.map((clip) => ({
      cameraId: clip.cameraId,
      objectPath: objectPath(options.party, options.channel, 1, clip.cameraId),
      sha256: clip.sha256,
      sizeBytes: clip.sizeBytes,
      durationMs: clip.durationMs,
      expiresAt,
    }));
    const publishedManifest = {
      partyId: options.party,
      channelId: options.channel,
      version: 1,
      schemaVersion: SCHEMA_VERSION,
      jobId: PILOT_JOB_ID,
      cameraClips,
      createdAt: timestamp,
      expiresAt,
    };
    const present = await Promise.all(clips.map((clip) =>
      bucket.file(objectPath(options.party, options.channel, 1, clip.cameraId)).exists().then(([value]) => value)));
    if (present.some((value) => !value)) fail("Seeded objects changed during upload (a concurrent sweep may have removed them); refusing partial commit.");
    commitAttempted = true;
    await db.runTransaction(async (transaction) => {
      const [partySnapshot, deviceSnapshot, channelSnapshot, manifestSnapshot, jobSnapshot] = await Promise.all([
        transaction.get(refsForSeed.party), transaction.get(refsForSeed.device), transaction.get(refsForSeed.channel),
        transaction.get(refsForSeed.manifest), transaction.get(refsForSeed.job),
      ]);
      if (manifestSnapshot.exists || jobSnapshot.exists) fail("Pilot state changed during upload; the transaction refused to replace it.");
      const partyData = partySnapshot.data();
      const deviceData = deviceSnapshot.data();
      const channelData = channelSnapshot.data();
      if (partySnapshot.exists && (partyData?.status !== "active" || partyData?.activeChannelId !== options.channel)) fail("Party changed during upload.");
      if (deviceSnapshot.exists && (deviceData?.status !== "active" || deviceData?.partyId !== options.party)) fail("Device changed during upload.");
      if (channelSnapshot.exists && (channelData?.status !== "active" || channelData?.partyId !== options.party)) fail("Channel changed during upload.");
      if (!partySnapshot.exists) transaction.create(refsForSeed.party, { ownerUid: null, status: "active", activeChannelId: options.channel, createdAt: timestamp });
      if (!deviceSnapshot.exists) transaction.create(refsForSeed.device, { partyId: options.party, deviceId: options.device, label: "TV", role: "tv", status: "active", registeredAt: timestamp });
      if (!channelSnapshot.exists) transaction.create(refsForSeed.channel, { partyId: options.party, channelId: options.channel, status: "active", createdAt: timestamp });
      transaction.create(refsForSeed.manifest, publishedManifest);
      transaction.create(refsForSeed.job, {
        jobId: PILOT_JOB_ID,
        partyId: options.party,
        deviceId: options.device,
        channelId: options.channel,
        state: "ready",
        status: "ready",
        // Server-authored fixed literal: this operator tool is a trusted
        // creation path, so it stamps the unbound text-only marker the
        // delivery provenance gate requires. Never caller input.
        kind: "text-only",
        presetId: "pilot_fixture",
        modelId: "offline-fixture",
        sourceManifestVersion: 0,
        manifestVersion: 1,
        idempotencyKey: SEED_KEY,
        publishedManifest,
        deliveryPaths: cameraClips.map((clip) => clip.objectPath),
        generatedPaths: [],
        createdAt: timestamp,
        readyAt: timestamp,
        timestamp,
        expiresAt: expiresTimestamp,
      });
    });
  } catch (error) {
    if (!commitAttempted) await Promise.all(uploaded.map((path) => bucket.file(path).delete({ ignoreNotFound: true }).catch(() => undefined)));
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const { projectId, bucketName } = selectEnvironment(options);
  const app = initializeApp({ projectId, storageBucket: bucketName }, `seed-pilot-${randomUUID()}`);
  try {
    const db = getFirestore(app);
    const bucket = getStorage(app).bucket(bucketName);
    const clips = await loadFixtures();
    const existing = await validateExisting(db, bucket, options, clips);
    const preview = { target: options.target, projectId, bucket: bucketName, party: options.party, device: options.device, channel: options.channel, version: 1, jobId: PILOT_JOB_ID, clips: clips.map(({ cameraId, sha256, sizeBytes, durationMs }) => ({ cameraId, sha256, sizeBytes, durationMs })) };
    if (existing !== "new") {
      process.stdout.write(`${JSON.stringify({ result: existing, applied: false, ...preview })}\n`);
      return;
    }
    if (!options.apply) {
      process.stdout.write(`${JSON.stringify({ result: "preview", applied: false, ...preview })}\n`);
      return;
    }
    await applySeed(db, bucket, options, clips);
    process.stdout.write(`${JSON.stringify({ result: "seeded", applied: true, ...preview })}\n`);
  } finally {
    await deleteApp(app);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
