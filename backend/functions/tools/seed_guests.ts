/**
 * Guest device-code seeder. Writes Firestore device registrations only
 * (no Storage, no provider calls): one `guest` device doc per guest code
 * under `parties/{party}/devices/{code}`, and merges `role: "tv"` onto the
 * existing TV device so the host-only listPartyDevices callable accepts it.
 *
 * Consent guarantee: device registration seeding NEVER creates guest
 * consent. This tool writes only device docs (partyId/deviceId/label/role/
 * status/registeredAt) — never guestMedia docs, never consent records, never
 * provenance. The CREATES_GUEST_CONSENT export is asserted false by the
 * consent-migration test suite.
 *
 * Default is a read-only preview that prints the host code sheet. Writes
 * require --apply. Cloud targets require explicit --party/--channel/
 * --tv-device and refuse guessable explicit codes; omit --codes to generate
 * unguessable codes. Service-account keys are never used (operator ADC).
 */
import { deleteApp, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { buildGuestSpecs, renderHostSheet } from "./guest_codes";

const DEFAULT_PARTY = "pilot";
const DEFAULT_TV_DEVICE = "tv-pilot";
const DEFAULT_CHANNEL = "haunted_surveillance";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
type Target = "emulator" | "cloud";

/** Device registration never creates guest consent (asserted by tests). */
export const CREATES_GUEST_CONSENT = false as const;

interface Options {
  target: Target;
  project?: string;
  party: string;
  channel: string;
  tvDevice: string;
  count?: number;
  codes?: string[];
  labelPrefix: string;
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
  const party = values.party ?? process.env.GUEST_PARTY_ID ?? (target === "emulator" ? DEFAULT_PARTY : "");
  const channel = values.channel ?? process.env.GUEST_CHANNEL_ID ?? (target === "emulator" ? DEFAULT_CHANNEL : "");
  const tvDevice = values["tv-device"] ?? process.env.GUEST_TV_DEVICE_ID ?? (target === "emulator" ? DEFAULT_TV_DEVICE : "");
  if (target === "cloud" && (!values.party || !values.channel || !values["tv-device"])) {
    fail("Cloud guest seeding requires explicit --party, --channel, and --tv-device (never the pilot defaults).");
  }
  for (const [label, id] of [["party", party], ["channel", channel], ["tv-device", tvDevice]] as const) {
    if (!ID_RE.test(id)) fail(`${label} ID is invalid.`);
  }
  if (target === "cloud" && (party === DEFAULT_PARTY || tvDevice === DEFAULT_TV_DEVICE)) {
    fail("Cloud guest seeding refuses the guessable pilot defaults; provision unguessable party/TV-device IDs.");
  }
  let count: number | undefined;
  let codes: string[] | undefined;
  if (values.codes !== undefined) {
    if (values.count !== undefined) fail("Use either --codes or --count, not both.");
    codes = values.codes.split(",").map((code) => code.trim()).filter((code) => code.length > 0);
  } else if (values.count !== undefined) {
    const parsed = Number(values.count);
    if (!Number.isSafeInteger(parsed)) fail(`Guest --count must be an integer, got ${values.count}.`);
    count = parsed;
  }
  const labelPrefix = (values["label-prefix"] ?? "Guest").trim() || "Guest";
  return { target, project: values.project, party, channel, tvDevice, count, codes, labelPrefix, apply };
}

function selectProject(options: Options): string {
  const firestoreEmulator = process.env.FIRESTORE_EMULATOR_HOST;
  if (options.target === "emulator") {
    if (!firestoreEmulator) fail("Emulator guest seeding requires FIRESTORE_EMULATOR_HOST.");
    if (options.apply && options.project && !options.project.startsWith("demo-")) {
      fail("Emulator apply requires a demo project ID; cloud project IDs must use the explicit cloud path.");
    }
    return options.project ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "demo-halloween-tv";
  }
  if (firestoreEmulator || process.env.STORAGE_EMULATOR_HOST) {
    fail("Cloud guest seeding refuses emulator environment variables; clear them before selecting a cloud target.");
  }
  if (!options.project) fail("Cloud guest seeding requires an explicit --project=PROJECT flag.");
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
  const guests = buildGuestSpecs({ target: options.target, count: options.count, codes: options.codes, labelPrefix: options.labelPrefix });
  if (!options.apply) {
    console.log(renderHostSheet({ party: options.party, channel: options.channel, tvDevice: options.tvDevice, guests, applied: false }));
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
      fail(`Party ${options.party} has a different active channel; refusing guest attach.`);
    }
    if (!channelSnap.exists || channelSnap.data()?.status !== "active" || channelSnap.data()?.partyId !== options.party) {
      fail(`Channel ${options.channel} is missing or inactive; refusing guest attach.`);
    }
    if (!tvSnap.exists || tvSnap.data()?.status !== "active" || tvSnap.data()?.partyId !== options.party) {
      fail(`TV device ${options.tvDevice} is missing or inactive; refusing guest attach.`);
    }
    const guestRefs = guests.map((guest) => db.doc(`parties/${options.party}/devices/${guest.deviceId}`));
    // Firestore transactions require every read before any write: snapshot
    // all guest docs first, then create only the missing ones.
    const existingGuests = await db.getAll(...guestRefs);
    const missing = guests.filter((_, index) => {
      const snapshot = existingGuests[index];
      if (!snapshot.exists) return true;
      const data = snapshot.data()!;
      if (data.partyId !== options.party || data.role !== "guest" || data.status !== "active") {
        fail(`Guest code ${guests[index].deviceId} collides with an unrelated device doc; refusing overwrite.`);
      }
      return false;
    });
    const batch = db.batch();
    for (const guest of missing) {
      batch.create(db.doc(`parties/${options.party}/devices/${guest.deviceId}`), {
        partyId: options.party,
        deviceId: guest.deviceId,
        label: guest.label,
        role: "guest",
        status: "active",
        registeredAt: FieldValue.serverTimestamp(),
      });
    }
    batch.set(tvRef, { role: "tv", label: "TV" }, { merge: true });
    await batch.commit();
    console.log(renderHostSheet({ party: options.party, channel: options.channel, tvDevice: options.tvDevice, guests, applied: true }));
  } finally {
    await deleteApp(app);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`seed_guests failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}