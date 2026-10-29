import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { REQUIRED_CAMERA_IDS } from "../src/config";
import { createGenerationServices } from "../src/generation";
import { FakeVideoGenerationPort } from "../src/providers/fake";

async function main(): Promise<void> {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.STORAGE_EMULATOR_HOST) {
    throw new Error("Dry run requires FIRESTORE_EMULATOR_HOST and STORAGE_EMULATOR_HOST; production Firebase is refused.");
  }
  const projectId = process.env.GCLOUD_PROJECT ?? "demo-halloween-tv";
  const partyId = `dryrun-${randomUUID().replace(/-/g, "")}`;
  const deviceId = "dry-run-device";
  const channelId = "main";
  const jobId = `job-${randomUUID().replace(/-/g, "")}`;
  const idempotencyKey = jobId;
  const app = initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` }, `dry-run-${randomUUID()}`);
  const db = getFirestore(app);
  const bucket = getStorage(app).bucket();
  try {
    const party = db.doc(`parties/${partyId}`);
    await Promise.all([
      party.set({ status: "active", activeChannelId: channelId }),
      party.collection("devices").doc(deviceId).set({ partyId, deviceId, status: "active" }),
      party.collection("channels").doc(channelId).set({ partyId, channelId, status: "active" }),
    ]);
    const services = createGenerationServices({ db, bucket, provider: new FakeVideoGenerationPort() });
    const request = await services.requestGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey, presetId: "cheap_demo" });
    const result = await services.runGeneration({ partyId, deviceId, channelId, jobId, idempotencyKey });
    const current = (await db.doc(`parties/${partyId}/manifests/current_${channelId}`).get()).data();
    process.stdout.write(`${JSON.stringify({
      mode: "fake-dry-run",
      networkGenerationCalls: 0,
      billableCalls: 0,
      request,
      result,
      manifestVersion: current?.version,
      cameraIds: Array.isArray(current?.cameraClips) ? current?.cameraClips.map((clip: { cameraId: string }) => clip.cameraId) : [],
      expectedCameraIds: REQUIRED_CAMERA_IDS,
    })}\n`);
  } finally {
    await db.recursiveDelete(db.doc(`parties/${partyId}`));
    const [files] = await bucket.getFiles({ prefix: `parties/${partyId}/` });
    await Promise.all(files.map((file) => file.delete({ ignoreNotFound: true })));
    await deleteApp(app);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
