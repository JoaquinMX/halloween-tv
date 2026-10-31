import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment, RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, collection, getDocs } from "firebase/firestore";
import { HAS_FIRESTORE_EMULATOR, PROJECT_ID, emulatorHost } from "./support/emulators";

test("Firestore allows only registered device registration reads and denies client writes", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const host = emulatorHost();
  const rules = await readFile(resolve(__dirname, "../../firestore.rules"), "utf8");
  const env: RulesTestEnvironment = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: host.host, port: host.port, rules },
  });
  try {
    await env.withSecurityRulesDisabled(async (context) => {
      const firestore = context.firestore();
      await setDoc(doc(firestore, "parties/pilot"), { status: "active", activeChannelId: "main" });
      await setDoc(doc(firestore, "parties/pilot/devices/tv-1"), { partyId: "pilot", status: "active" });
      await setDoc(doc(firestore, "parties/pilot/channels/main"), { partyId: "pilot", status: "active" });
      await setDoc(doc(firestore, "parties/pilot/manifests/current_main"), { partyId: "pilot", channelId: "main", version: 1 });
    });
    const client = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(client, "parties/pilot/devices/tv-1")));
    await assertFails(getDoc(doc(client, "parties/pilot/devices/unknown")));
    await assertFails(getDoc(doc(client, "parties/other/devices/tv-1")));
    await assertFails(getDoc(doc(client, "parties/pilot")));
    await assertFails(getDoc(doc(client, "parties/pilot/channels/main")));
    await assertFails(getDoc(doc(client, "parties/pilot/manifests/current_main")));
    await assertFails(setDoc(doc(client, "parties/pilot/devices/tv-1"), { status: "disabled" }));
    await assertFails(setDoc(doc(client, "parties/pilot/jobs/forged"), { state: "ready" }));
  } finally {
    await env.cleanup();
  }
});

test("anonymous clients cannot self-register, list devices, or read party PIN state", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const host = emulatorHost();
  const rules = await readFile(resolve(__dirname, "../../firestore.rules"), "utf8");
  const env: RulesTestEnvironment = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: host.host, port: host.port, rules },
  });
  try {
    await env.withSecurityRulesDisabled(async (context) => {
      const firestore = context.firestore();
      await setDoc(doc(firestore, "parties/pin-party"), {
        ownerUid: null,
        status: "active",
        activeChannelId: "main",
        joinPin: "004201",
      });
      await setDoc(doc(firestore, "parties/pin-party/devices/tv-1"), { partyId: "pin-party", deviceId: "tv-1", role: "tv", status: "active" });
      await setDoc(doc(firestore, "parties/pin-party/channels/main"), { partyId: "pin-party", channelId: "main", status: "active" });
    });
    const client = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(client, "parties/pin-party/devices/p-self"), {
      partyId: "pin-party",
      deviceId: "p-self",
      role: "guest",
      status: "active",
    }));
    await assertFails(setDoc(doc(client, "parties/pin-party/devices/tv-1"), { status: "disabled" }));
    await assertFails(getDocs(collection(client, "parties/pin-party/devices")));
    await assertFails(getDoc(doc(client, "parties/pin-party")));
    await assertFails(getDoc(doc(client, "parties/pin-party/channels/main")));
  } finally {
    await env.cleanup();
  }
});

test("anonymous clients cannot read or mutate guest consent and media records", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const host = emulatorHost();
  const rules = await readFile(resolve(__dirname, "../../firestore.rules"), "utf8");
  assert.ok(rules.includes("guestMedia"), "firestore rules carry an explicit guest consent/media section");
  const env: RulesTestEnvironment = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: host.host, port: host.port, rules },
  });
  try {
    await env.withSecurityRulesDisabled(async (context) => {
      const firestore = context.firestore();
      await setDoc(doc(firestore, "parties/guest-party"), { status: "active", activeChannelId: "main" });
      await setDoc(doc(firestore, "parties/guest-party/devices/p-1"), { partyId: "guest-party", status: "active" });
      await setDoc(doc(firestore, "parties/guest-party/guestMedia/gsub-1"), {
        submissionId: "gsub-1", partyId: "guest-party", deviceId: "p-1", channelId: "main", status: "eligible",
      });
    });
    const client = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(client, "parties/guest-party/guestMedia/gsub-1")));
    await assertFails(setDoc(doc(client, "parties/guest-party/guestMedia/gsub-1"), { status: "withdrawn" }));
    await assertFails(setDoc(doc(client, "parties/guest-party/guestMedia/gsub-forged"), { status: "eligible" }));
  } finally {
    await env.cleanup();
  }
});

test("anonymous clients cannot read or mutate host invites and seed catalog records", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const host = emulatorHost();
  const rules = await readFile(resolve(__dirname, "../../firestore.rules"), "utf8");
  const env: RulesTestEnvironment = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: host.host, port: host.port, rules },
  });
  try {
    await env.withSecurityRulesDisabled(async (context) => {
      const firestore = context.firestore();
      await setDoc(doc(firestore, "parties/host-party"), { status: "active", activeChannelId: "main" });
      await setDoc(doc(firestore, "parties/host-party/devices/tv-1"), { partyId: "host-party", status: "active" });
      await setDoc(doc(firestore, "parties/host-party/hostInvites/invite-1"), {
        tokenHash: "a".repeat(64), partyId: "host-party", channelId: "main", status: "pending",
      });
      await setDoc(doc(firestore, "parties/host-party/seedVideos/seed-1"), {
        seedId: "seed-1", partyId: "host-party", channelId: "main", status: "ready",
      });
      await setDoc(doc(firestore, "parties/other-party"), { status: "active", activeChannelId: "main" });
      await setDoc(doc(firestore, "parties/other-party/hostInvites/invite-9"), {
        tokenHash: "b".repeat(64), partyId: "other-party", channelId: "main", status: "pending",
      });
    });
    // Every caller context is denied: unauthenticated AND device-authed AND
    // cross-party. No direct client reads, writes, or listing on invites or
    // the seed catalog; all access is callable-only through the Admin SDK.
    for (const client of [env.unauthenticatedContext().firestore(), env.authenticatedContext("tv-1").firestore()]) {
      await assertFails(getDoc(doc(client, "parties/host-party/hostInvites/invite-1")));
      await assertFails(setDoc(doc(client, "parties/host-party/hostInvites/invite-1"), { status: "redeemed" }));
      await assertFails(setDoc(doc(client, "parties/host-party/hostInvites/forged"), { status: "pending" }));
      await assertFails(getDocs(collection(client, "parties/host-party/hostInvites")));
      await assertFails(getDoc(doc(client, "parties/host-party/seedVideos/seed-1")));
      await assertFails(setDoc(doc(client, "parties/host-party/seedVideos/seed-1"), { status: "deleted" }));
      await assertFails(setDoc(doc(client, "parties/host-party/seedVideos/forged"), { status: "ready" }));
      await assertFails(getDocs(collection(client, "parties/host-party/seedVideos")));
      // Cross-party reads are denied from every context as well.
      await assertFails(getDoc(doc(client, "parties/other-party/hostInvites/invite-9")));
    }
  } finally {
    await env.cleanup();
  }
});

test("storage rules deny read/write/list on host previews for every caller context", { skip: !HAS_FIRESTORE_EMULATOR || !process.env.STORAGE_EMULATOR_HOST }, async () => {
  const host = emulatorHost();
  // STORAGE_EMULATOR_HOST may carry an http(s) scheme in newer firebase-tools.
  const [storageHost, rawStoragePort] = (process.env.STORAGE_EMULATOR_HOST ?? "127.0.0.1:9199").replace(/^https?:\/\//, "").split(":");
  const rules = await readFile(resolve(__dirname, "../../storage.rules"), "utf8");
  const env: RulesTestEnvironment = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: host.host, port: host.port },
    storage: { host: storageHost, port: Number(rawStoragePort ?? 9199), rules },
  });
  const previewPath = (party: string) => `parties/${party}/hostPreviews/seed-1/CAM-01.mp4`;
  try {
    // Seed preview bytes with rules disabled (Admin SDK equivalent).
    await env.withSecurityRulesDisabled(async (context) => {
      const storage = context.storage();
      await storage.ref(previewPath("host-party")).put(new Uint8Array([1, 2, 3, 4]));
    });
    // Host previews ride the catch-all deny: no direct client reads, writes,
    // listing, or deletes. Signed preview URLs bypass rules with backend
    // validation, exactly like delivery URLs; the backend never persists them.
    // Denied for unauthenticated AND device-authed callers alike.
    for (const context of [env.unauthenticatedContext(), env.authenticatedContext("tv-1")]) {
      const storage = context.storage();
      await assertFails(storage.ref(previewPath("host-party")).getDownloadURL());
      await assertFails(storage.ref(previewPath("host-party")).getMetadata());
      await assertFails(storage.ref(previewPath("host-party")).put(new Uint8Array([9])).then(() => undefined));
      await assertFails(storage.ref(previewPath("host-party")).delete());
      await assertFails(storage.ref("parties/host-party/hostPreviews/seed-1").listAll());
      // Cross-party preview objects are denied from every context as well.
      await assertFails(storage.ref(previewPath("other-party")).getDownloadURL());
      await assertFails(storage.ref(previewPath("other-party")).put(new Uint8Array([9])).then(() => undefined));
      // The guest-ingest prefix stays denied for direct reads/writes/deletes
      // in every context (signed PUT capabilities bypass rules instead).
      await assertFails(storage.ref("parties/host-party/guests/p-1/ingest/gsub-1/photo.jpg").getDownloadURL());
      await assertFails(storage.ref("parties/host-party/guests/p-1/ingest/gsub-1/photo.jpg").put(new Uint8Array([9])).then(() => undefined));
    }
  } finally {
    await env.cleanup();
  }
});
