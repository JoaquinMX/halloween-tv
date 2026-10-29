import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment, RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
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
    });
    const client = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(client, "parties/pilot/devices/tv-1")));
    await assertFails(getDoc(doc(client, "parties/pilot/devices/unknown")));
    await assertFails(getDoc(doc(client, "parties/other/devices/tv-1")));
    await assertFails(getDoc(doc(client, "parties/pilot")));
    await assertFails(getDoc(doc(client, "parties/pilot/channels/main")));
    await assertFails(setDoc(doc(client, "parties/pilot/devices/tv-1"), { status: "disabled" }));
    await assertFails(setDoc(doc(client, "parties/pilot/jobs/forged"), { state: "ready" }));
  } finally {
    await env.cleanup();
  }
});
