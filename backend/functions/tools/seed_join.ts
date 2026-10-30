/**
 * Join-PIN provisioning tool. Merges `joinPin` onto the existing party doc
 * (`parties/{party}`) so the TV can render it inside the session QR payload
 * and the joinParty callable can challenge companions with it.
 *
 * Firestore only: no Storage writes, no media uploads, no provider calls, no
 * guest device creation, no labels collected. Registration-free provisioning
 * for the host operator (the TV panel shows the QR; companions self-register
 * through the joinParty callable, which uses Admin SDK writes server-side).
 *
 * Default is a read-only preview. Writes require --apply. Cloud targets
 * require explicit --party/--channel/--tv-device/--project and refuse the
 * guessable pilot defaults. Service-account keys are never used (operator
 * ADC). The PIN is exactly six ASCII digits; leading zeros are significant
 * and preserved as a string (never parsed as a number).
 */
import { deleteApp, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const DEFAULT_PARTY = "pilot";
const DEFAULT_TV_DEVICE = "tv-pilot";
const DEFAULT_CHANNEL = "haunted_surveillance";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const JOIN_PIN_RE = /^[0-9]{6}$/;
type Target = "emulator" | "cloud";

interface Options {
  target: Target;
  project?: string;
  party: string;
  channel: string;
  tvDevice: string;
  joinPin?: string;
  apply: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseOptions(args: string[]): Options {
  const values: Record<string, string> = {};
  let apply = false;
  for (const arg of args) {
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) fail(`Unknown seed argument ${arg}; use --name=value and opt into writes with --apply.`);
    values[match[1]] = match[2];
  }
  const target = values.target as Target | undefined;
  if (target !== "emulator" && target !== "cloud") fail("Seed requires explicit --target=emulator or --target=cloud.");
  const party = values.party ?? process.env.JOIN_PARTY_ID ?? (target === "emulator" ? DEFAULT_PARTY : "");
  const channel = values.channel ?? process.env.JOIN_CHANNEL_ID ?? (target === "emulator" ? DEFAULT_CHANNEL : "");
  const tvDevice = values["tv-device"] ?? process.env.JOIN_TV_DEVICE_ID ?? (target === "emulator" ? DEFAULT_TV_DEVICE : "");
  if (target === "cloud" && (!values.party || !values.channel || !values["tv-device"])) {
    fail("Cloud join-PIN provisioning requires explicit --party, --channel, and --tv-device (never the pilot defaults).");
  }
  for (const [label, id] of [["party", party], ["channel", channel], ["tv-device", tvDevice]] as const) {
    if (!ID_RE.test(id)) fail(`${label} ID is invalid.`);
  }
  if (target === "cloud" && (party === DEFAULT_PARTY || tvDevice === DEFAULT_TV_DEVICE)) {
    fail("Cloud join-PIN provisioning refuses the guessable pilot defaults; provision unguessable party/TV-device IDs.");
  }
  let joinPin: string | undefined;
  if (values["join-pin"] !== undefined) {
    if (!JOIN_PIN_RE.test(values["join-pin"])) {
      fail(`--join-pin must be exactly six ASCII digits (leading zeros significant), got ${JSON.stringify(values["join-pin"])}.`);
    }
    joinPin = values["join-pin"];
  }
  return { target, project: values.project, party, channel, tvDevice, joinPin, apply };
}

function selectProject(options: Options): string {
  const firestoreEmulator = process.env.FIRESTORE_EMULATOR_HOST;
  if (options.target === "emulator") {
    if (!firestoreEmulator) fail("Emulator join-PIN provisioning requires FIRESTORE_EMULATOR_HOST.");
    if (options.apply && options.project && !options.project.startsWith("demo-")) {
      fail("Emulator apply requires a demo project ID; cloud project IDs must use the explicit cloud path.");
    }
    return options.project ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "demo-halloween-tv";
  }
  if (firestoreEmulator || process.env.STORAGE_EMULATOR_HOST) {
    fail("Cloud join-PIN provisioning refuses emulator environment variables; clear them before selecting a cloud target.");
  }
  if (!options.project) fail("Cloud join-PIN provisioning requires an explicit --project=PROJECT flag.");
  const ambientProject = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (ambientProject && ambientProject !== options.project) {
    fail("Explicit --project disagrees with GCLOUD_PROJECT/GOOGLE_CLOUD_PROJECT; clear the conflicting target.");
  }
  if (options.project.startsWith("demo-")) fail("Cloud seed target cannot use a demo project ID.");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project)) fail("Firebase project ID is invalid.");
  return options.project;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const projectId = selectProject(options);
  const previewBase = {
    target: options.target,
    projectId,
    party: options.party,
    channel: options.channel,
    tvDevice: options.tvDevice,
  };
  if (!options.apply) {
    if (options.joinPin === undefined) {
      console.log(JSON.stringify({ ...previewBase, result: "preview", applied: false, joinPin: null, note: "preview only: pass --join-pin=NNNNNN and --apply to provision; omitting --join-pin never changes a stored PIN" }));
      return;
    }
    console.log(JSON.stringify({ ...previewBase, result: "preview", applied: false, joinPin: options.joinPin }));
    return;
  }
  const app = initializeApp({ projectId });
  try {
    const db = getFirestore(app);
    const partyRef = db.doc(`parties/${options.party}`);
    const channelRef = db.doc(`parties/${options.party}/channels/${options.channel}`);
    const tvRef = db.doc(`parties/${options.party}/devices/${options.tvDevice}`);
    const [partySnap, channelSnap, tvSnap] = await Promise.all([partyRef.get(), channelRef.get(), tvRef.get()]);
    if (!partySnap.exists || partySnap.data()?.status !== "active") {
      fail(`Party ${options.party} is missing or inactive; seed the party/TV with seed_pilot first.`);
    }
    if (partySnap.data()?.activeChannelId !== options.channel) {
      fail(`Party ${options.party} has a different active channel; refusing PIN provisioning.`);
    }
    if (!channelSnap.exists || channelSnap.data()?.status !== "active" || channelSnap.data()?.partyId !== options.party) {
      fail(`Channel ${options.channel} is missing or inactive; refusing PIN provisioning.`);
    }
    if (!tvSnap.exists || tvSnap.data()?.status !== "active" || tvSnap.data()?.partyId !== options.party) {
      fail(`TV device ${options.tvDevice} is missing or inactive; refusing PIN provisioning.`);
    }
    const tvRole = tvSnap.data()?.role;
    if (tvRole !== undefined && tvRole !== "tv") {
      fail(`Device ${options.tvDevice} is not the registered TV (role ${JSON.stringify(tvRole)}); refusing PIN provisioning.`);
    }
    const currentPin = partySnap.data()?.joinPin;
    if (options.joinPin === undefined) {
      console.log(JSON.stringify({
        ...previewBase,
        result: "unchanged",
        applied: false,
        joinPin: typeof currentPin === "string" ? currentPin : null,
        note: "no --join-pin: existing PIN left untouched",
      }));
      return;
    }
    if (currentPin === options.joinPin) {
      console.log(JSON.stringify({ ...previewBase, result: "already-provisioned", applied: false, joinPin: options.joinPin }));
      return;
    }
    if (currentPin !== undefined && (typeof currentPin !== "string" || !JOIN_PIN_RE.test(currentPin))) {
      fail(`Party ${options.party} carries a malformed stored joinPin; refusing overwrite without operator review.`);
    }
    await partyRef.set({ joinPin: options.joinPin, pinUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
    console.log(JSON.stringify({ ...previewBase, result: "provisioned", applied: true, joinPin: options.joinPin }));
  } finally {
    await deleteApp(app);
  }
}

main().catch((error: unknown) => {
  console.error(`seed_join failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
