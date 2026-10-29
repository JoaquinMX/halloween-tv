/**
 * Pilot seeder for the Firebase emulators. Non-billable fixture media only —
 * it never calls a generation provider. Safe to run repeatedly (idempotent).
 *
 * Usage (from backend/functions):
 *   npm run seed:pilot
 * Requires FIRESTORE_EMULATOR_HOST / STORAGE_EMULATOR_HOST (see .env.example).
 */
import { createHash } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { REQUIRED_CAMERA_IDS, SCHEMA_VERSION } from "../src/config";

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "demo-halloween-tv";
const PARTY_ID = process.env.PILOT_PARTY_ID ?? "pilot";
const DEVICE_ID = process.env.PILOT_DEVICE_ID ?? "tv-pilot";
const CHANNEL_ID = process.env.PILOT_CHANNEL_ID ?? "main";

async function main(): Promise<void> {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("FIRESTORE_EMULATOR_HOST is not set. Refusing to seed anything but the emulator.");
  }
  const app = initializeApp({ projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` }, "seed-pilot");
  const db = getFirestore(app);
  const bucket = getStorage(app).bucket();
  const version = 1;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const party = db.doc(`parties/${PARTY_ID}`);
  await party.set({ ownerUid: null, status: "active", activeChannelId: CHANNEL_ID }, { merge: true });
  await party.collection("devices").doc(DEVICE_ID).set(
    { partyId: PARTY_ID, deviceId: DEVICE_ID, status: "active", registeredAt: new Date().toISOString() },
    { merge: true },
  );
  await party.collection("channels").doc(CHANNEL_ID).set(
    { partyId: PARTY_ID, channelId: CHANNEL_ID, status: "active" },
    { merge: true },
  );

  const cameraClips = [];
  for (const cameraId of REQUIRED_CAMERA_IDS) {
    // Deterministic non-billable fixture bytes; the TV plays these, never provider output.
    const bytes = Buffer.from(`pilot-fixture:${PARTY_ID}:${CHANNEL_ID}:${version}:${cameraId}`);
    const objectPath = `parties/${PARTY_ID}/channels/${CHANNEL_ID}/delivery/${version}/${cameraId}.mp4`;
    await bucket.file(objectPath).save(bytes, {
      metadata: {
        contentType: "video/mp4",
        metadata: { expiresAt, jobId: "seed-pilot", partyId: PARTY_ID, purpose: "delivery" },
      },
    });
    cameraClips.push({
      cameraId,
      objectPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
      durationMs: 2000,
      expiresAt,
    });
  }
  await db.doc(`parties/${PARTY_ID}/manifests/current_${CHANNEL_ID}`).set({
    partyId: PARTY_ID,
    channelId: CHANNEL_ID,
    version,
    schemaVersion: SCHEMA_VERSION,
    jobId: "seed-pilot",
    cameraClips,
    expiresAt,
  });
  // eslint-disable-next-line no-console
  console.log(`seeded party=${PARTY_ID} device=${DEVICE_ID} channel=${CHANNEL_ID} version=${version}`);
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
