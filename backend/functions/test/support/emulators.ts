import { randomUUID } from "node:crypto";
import { App, deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import type { Bucket } from "@google-cloud/storage";

export const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "demo-halloween-tv";
export const HAS_FIRESTORE_EMULATOR = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

export function emulatorHost(): { host: string; port: number } {
  const [host, rawPort] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":");
  return { host, port: Number(rawPort ?? 8080) };
}

export async function createEmulatorContext(): Promise<{ app: App; db: Firestore; bucket: Bucket }> {
  if (!HAS_FIRESTORE_EMULATOR) throw new Error("FIRESTORE_EMULATOR_HOST is not configured.");
  const app = initializeApp({ projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` }, `test-${randomUUID()}`);
  return { app, db: getFirestore(app), bucket: getStorage(app).bucket() };
}

export async function disposeEmulatorContext(app: App): Promise<void> {
  await deleteApp(app);
}

export async function seedParty(db: Firestore, partyId: string, deviceId: string, channelId: string): Promise<void> {
  const party = db.doc(`parties/${partyId}`);
  await Promise.all([
    party.set({ ownerUid: null, status: "active", activeChannelId: channelId, createdAt: new Date().toISOString() }),
    party.collection("devices").doc(deviceId).set({ partyId, deviceId, status: "active", registeredAt: new Date().toISOString() }),
    party.collection("channels").doc(channelId).set({ partyId, channelId, status: "active" }),
  ]);
}

export async function clearParty(db: Firestore, bucket: Bucket, partyId: string): Promise<void> {
  const ref = db.doc(`parties/${partyId}`);
  await db.recursiveDelete(ref);
  const [files] = await bucket.getFiles({ prefix: `parties/${partyId}/` });
  await Promise.all(files.map((file: { delete: (options?: object) => Promise<unknown> }) => file.delete({ ignoreNotFound: true })));
}

export function randomPartyId(): string {
  return `test-${randomUUID().replace(/-/g, "")}`;
}
