import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { HAS_FIRESTORE_EMULATOR, PROJECT_ID, clearParty, createEmulatorContext, disposeEmulatorContext, randomPartyId } from "./support/emulators";

const PACKAGE_ROOT = process.cwd();

type ToolResult = { status: number | null; stdout: string; stderr: string };

function runTool(args: string[], env: NodeJS.ProcessEnv): ToolResult {
  const result = spawnSync(process.execPath, ["--import", "tsx", "tools/seed_join.ts", ...args], {
    cwd: PACKAGE_ROOT,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["FIRESTORE_EMULATOR_HOST", "STORAGE_EMULATOR_HOST", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT",
    "STORAGE_BUCKET", "JOIN_PARTY_ID", "JOIN_CHANNEL_ID", "JOIN_TV_DEVICE_ID"]) {
    delete env[name];
  }
  return env;
}

/** Refusal tests only need the emulator variable present, not a live emulator. */
function fakeEmulatorEnv(projectId = "real-project-12345"): NodeJS.ProcessEnv {
  return { ...cleanEnv(), FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", GCLOUD_PROJECT: projectId };
}

function lastJson(stdout: string): Record<string, any> {
  const lines = stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length > 0, "tool produced no JSON output");
  return JSON.parse(lines[lines.length - 1]) as Record<string, any>;
}

function emulatorEnv(): NodeJS.ProcessEnv {
  return { ...cleanEnv(), FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST!, GCLOUD_PROJECT: PROJECT_ID };
}

test("seed_join refuses missing targets, malformed PINs, and unsafe cloud targets", () => {
  const missingTarget = runTool(["--apply"], cleanEnv());
  assert.notEqual(missingTarget.status, 0);
  assert.match(missingTarget.stderr, /explicit --target=emulator or --target=cloud/);

  const missingEmulator = runTool(["--target=emulator", "--apply"], cleanEnv());
  assert.notEqual(missingEmulator.status, 0);
  assert.match(missingEmulator.stderr, /requires FIRESTORE_EMULATOR_HOST/);

  for (const badPin of ["12345", "1234567", "abcdef", "12345a", "12 456", "00420x"]) {
    const result = runTool(["--target=emulator", `--join-pin=${badPin}`, "--apply"], fakeEmulatorEnv("demo-join-pins"));
    assert.notEqual(result.status, 0, `PIN ${JSON.stringify(badPin)} must be refused`);
    assert.match(result.stderr, /exactly six ASCII digits/);
  }
  const emptyPin = runTool(["--target=emulator", "--join-pin=", "--apply"], fakeEmulatorEnv("demo-join-pins"));
  assert.notEqual(emptyPin.status, 0, "an empty --join-pin must be refused");
  assert.match(emptyPin.stderr, /Unknown seed argument/);

  const implicitCloud = runTool(["--project=real-project-12345", "--apply"], cleanEnv());
  assert.notEqual(implicitCloud.status, 0);
  assert.match(implicitCloud.stderr, /explicit --target=emulator or --target=cloud/);

  const cloudWithoutFlags = runTool(["--target=cloud", "--apply"], cleanEnv());
  assert.notEqual(cloudWithoutFlags.status, 0);
  assert.match(cloudWithoutFlags.stderr, /explicit --party, --channel, and --tv-device/);

  const cloudWithoutProject = runTool(
    ["--target=cloud", "--party=live-party-abc", "--channel=haunted_surveillance", "--tv-device=tv-live-abc", "--join-pin=004201", "--apply"],
    cleanEnv());
  assert.notEqual(cloudWithoutProject.status, 0);
  assert.match(cloudWithoutProject.stderr, /explicit --project=PROJECT/);

  const cloudWithEmulator = runTool(
    ["--target=cloud", "--project=real-project-12345", "--party=live-party-abc", "--channel=haunted_surveillance",
      "--tv-device=tv-live-abc", "--join-pin=004201", "--apply"],
    fakeEmulatorEnv());
  assert.notEqual(cloudWithEmulator.status, 0);
  assert.match(cloudWithEmulator.stderr, /refuses emulator environment variables/);

  const cloudDemoProject = runTool(
    ["--target=cloud", "--project=demo-join-pins", "--party=live-party-abc", "--channel=haunted_surveillance",
      "--tv-device=tv-live-abc", "--join-pin=004201", "--apply"],
    cleanEnv());
  assert.notEqual(cloudDemoProject.status, 0);
  assert.match(cloudDemoProject.stderr, /cannot use a demo project ID/);

  const cloudPilotDefaults = runTool(
    ["--target=cloud", "--project=real-project-12345", "--party=pilot", "--channel=haunted_surveillance",
      "--tv-device=tv-pilot", "--join-pin=004201", "--apply"],
    cleanEnv());
  assert.notEqual(cloudPilotDefaults.status, 0);
  assert.match(cloudPilotDefaults.stderr, /refuses the guessable pilot defaults/);
});

test("seed_join previews, provisions, stays idempotent, and omits cleanly", {
  skip: !HAS_FIRESTORE_EMULATOR ? "requires the Firestore emulator" : false,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const tvDevice = "tv-host";
  const channelId = "haunted_surveillance";
  try {
    await db.doc(`parties/${partyId}`).set({ ownerUid: null, status: "active", activeChannelId: channelId, customField: "keep-me" });
    await db.doc(`parties/${partyId}/channels/${channelId}`).set({ partyId, channelId, status: "active" });
    await db.doc(`parties/${partyId}/devices/${tvDevice}`).set({ partyId, deviceId: tvDevice, label: "TV", role: "tv", status: "active" });

    const base = ["--target=emulator", `--party=${partyId}`, `--channel=${channelId}`, `--tv-device=${tvDevice}`];
    const preview = runTool([...base, "--join-pin=004201"], emulatorEnv());
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(lastJson(preview.stdout).result, "preview");
    assert.equal(lastJson(preview.stdout).joinPin, "004201");
    assert.equal((await db.doc(`parties/${partyId}`).get()).data()?.joinPin, undefined, "preview must not write a PIN");

    const first = runTool([...base, "--join-pin=004201", "--apply"], emulatorEnv());
    assert.equal(first.status, 0, first.stderr);
    const firstReport = lastJson(first.stdout);
    assert.equal(firstReport.result, "provisioned");
    assert.equal(firstReport.applied, true);
    assert.equal(firstReport.joinPin, "004201");
    const stored = (await db.doc(`parties/${partyId}`).get()).data()!;
    assert.equal(stored.joinPin, "004201", "leading zeros must be preserved verbatim as a string");
    assert.equal(typeof stored.joinPin, "string");
    assert.equal(stored.customField, "keep-me", "provisioning must preserve unrelated party fields");
    assert.equal(stored.status, "active");
    assert.equal(stored.activeChannelId, channelId);
    const devices = await db.collection(`parties/${partyId}/devices`).get();
    assert.deepEqual(devices.docs.map((doc) => doc.id).sort(), [tvDevice], "provisioning creates no guest devices");

    const repeat = runTool([...base, "--join-pin=004201", "--apply"], emulatorEnv());
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(lastJson(repeat.stdout).result, "already-provisioned");
    assert.equal(lastJson(repeat.stdout).applied, false);

    const omitted = runTool([...base, "--apply"], emulatorEnv());
    assert.equal(omitted.status, 0, omitted.stderr);
    assert.equal(lastJson(omitted.stdout).result, "unchanged");
    assert.equal(lastJson(omitted.stdout).joinPin, "004201", "omitting --join-pin leaves the stored PIN untouched");
    assert.equal((await db.doc(`parties/${partyId}`).get()).data()?.joinPin, "004201");

    const rotated = runTool([...base, "--join-pin=990011", "--apply"], emulatorEnv());
    assert.equal(rotated.status, 0, rotated.stderr);
    assert.equal(lastJson(rotated.stdout).result, "provisioned");
    assert.equal((await db.doc(`parties/${partyId}`).get()).data()?.joinPin, "990011");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("seed_join refuses missing or inactive party, channel, and TV state without writing", {
  skip: !HAS_FIRESTORE_EMULATOR ? "requires the Firestore emulator" : false,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const parties: string[] = [];
  try {
    const setup = async (partyId: string, mutate: () => Promise<void>): Promise<void> => {
      parties.push(partyId);
      await db.doc(`parties/${partyId}`).set({ ownerUid: null, status: "active", activeChannelId: "haunted_surveillance" });
      await db.doc(`parties/${partyId}/channels/haunted_surveillance`).set({ partyId, channelId: "haunted_surveillance", status: "active" });
      await db.doc(`parties/${partyId}/devices/tv-host`).set({ partyId, deviceId: "tv-host", label: "TV", role: "tv", status: "active" });
      await mutate();
    };

    const attempt = (partyId: string): ToolResult => runTool(["--target=emulator", `--party=${partyId}`,
      "--channel=haunted_surveillance", "--tv-device=tv-host", "--join-pin=004201", "--apply"], emulatorEnv());

    const missing = randomPartyId();
    parties.push(missing);
    const missingResult = attempt(missing);
    assert.notEqual(missingResult.status, 0);
    assert.match(missingResult.stderr, /missing or inactive/);

    const inactiveParty = randomPartyId();
    await setup(inactiveParty, async () => {
      await db.doc(`parties/${inactiveParty}`).set({ status: "inactive" }, { merge: true });
    });
    const inactiveResult = attempt(inactiveParty);
    assert.notEqual(inactiveResult.status, 0);
    assert.match(inactiveResult.stderr, /missing or inactive/);
    assert.equal((await db.doc(`parties/${inactiveParty}`).get()).data()?.joinPin, undefined);

    const wrongChannel = randomPartyId();
    await setup(wrongChannel, async () => {
      await db.doc(`parties/${wrongChannel}`).set({ activeChannelId: "other_channel" }, { merge: true });
    });
    const channelResult = runTool(["--target=emulator", `--party=${wrongChannel}`,
      "--channel=haunted_surveillance", "--tv-device=tv-host", "--join-pin=004201", "--apply"], emulatorEnv());
    assert.notEqual(channelResult.status, 0);
    assert.match(channelResult.stderr, /different active channel/);
    assert.equal((await db.doc(`parties/${wrongChannel}`).get()).data()?.joinPin, undefined);

    const missingTv = randomPartyId();
    await setup(missingTv, async () => {
      await db.doc(`parties/${missingTv}/devices/tv-host`).delete();
    });
    const tvResult = attempt(missingTv);
    assert.notEqual(tvResult.status, 0);
    assert.match(tvResult.stderr, /TV device .* missing or inactive/);
    assert.equal((await db.doc(`parties/${missingTv}`).get()).data()?.joinPin, undefined);

    const guestAsTv = randomPartyId();
    await setup(guestAsTv, async () => {
      await db.doc(`parties/${guestAsTv}/devices/tv-host`).set({ role: "guest" }, { merge: true });
    });
    const guestResult = attempt(guestAsTv);
    assert.notEqual(guestResult.status, 0);
    assert.match(guestResult.stderr, /not the registered TV/);
    assert.equal((await db.doc(`parties/${guestAsTv}`).get()).data()?.joinPin, undefined);
  } finally {
    for (const partyId of parties) {
      await clearParty(db, bucket, partyId);
    }
    await disposeEmulatorContext(app);
  }
});
