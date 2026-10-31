/**
 * Conservative consent-provenance migration (cycle-13 p3).
 *
 * Backfills versioned provenance (`provenance/v1`) onto historical guestMedia
 * docs from recorded evidence only. Defaults to a read-only, explicitly
 * scoped preview: nothing is written unless --apply is passed with an
 * explicit --party (optionally narrowed by --submission).
 *
 * Safety invariants (asserted by consent_migration.test.ts):
 * - Preview default: planning never writes.
 * - Explicit scope: --party is required; --submission narrows to one doc.
 * - Idempotent apply: re-running over stamped docs is a no-op.
 * - Fresh-state check: apply re-reads each doc transactionally and skips on
 *   conflict instead of overwriting concurrent changes.
 * - Preserves original evidence: consent, attestation, revision, hashes,
 *   withdrawal markers, tombstones, and retention deadlines are never
 *   altered — only the additive `provenance` field is stamped.
 * - Never fabricates guest acceptance: docs without recorded accepted
 *   supported consent stay unknown (no synthetic consent, no synthetic
 *   guestMedia). Explicitly approved legacy delivery remains available via
 *   the seed catalog without a guestMedia record.
 * - Never resets withdrawal, tombstones, or retention deadlines.
 * - Unknown historical provenance remains unknown until supported by
 *   recorded evidence.
 *
 * No provider calls, no secrets, no media bytes handled here.
 */
import { deleteApp, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Firestore } from "firebase-admin/firestore";
import {
  PROVENANCE_VERSION,
  ProvenanceRecord,
  provenanceFromGuestMediaDoc,
  provenanceUnknown,
  validateProvenanceRecord,
} from "../src/consent_provenance";

export type MigrationAction =
  | "stamp_provenance"
  | "already_current"
  | "leave_unknown"
  | "skip_withdrawn"
  | "skip_conflict";

export interface MigrationPlanEntry {
  partyId: string;
  submissionId: string;
  action: MigrationAction;
  reason: string;
  provenance?: ProvenanceRecord;
}

export interface PlannedDoc {
  partyId: string;
  submissionId: string;
  status?: string;
  tombstone?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameProvenanceBinding(existing: unknown, planned: ProvenanceRecord): boolean {
  if (!isRecord(existing)) return false;
  try {
    validateProvenanceRecord({ ...(existing as unknown as Record<string, unknown>) } as unknown as ProvenanceRecord);
  } catch {
    return false;
  }
  const current = existing as Record<string, unknown>;
  return (
    current.version === planned.version &&
    current.origin === planned.origin &&
    current.revision === planned.revision &&
    (current as { sourceHash?: unknown }).sourceHash === (planned.sourceHash ?? undefined) &&
    (current as { withdrawn?: unknown }).withdrawn === (planned.withdrawn ?? undefined)
  );
}

/**
 * Pure planner over server-read guestMedia docs. Never writes, never
 * fabricates acceptance: docs without recorded accepted supported consent
 * plan to `leave_unknown`, withdrawn/tombstoned docs plan to `skip_withdrawn`.
 */
export function planProvenanceMigration(
  docs: Array<Record<string, unknown>>,
  nowIso: string,
): MigrationPlanEntry[] {
  if (!Number.isFinite(Date.parse(nowIso))) throw new Error("nowIso must be a valid ISO timestamp.");
  return docs.map((doc) => {
    const partyId = typeof doc.partyId === "string" ? doc.partyId : "";
    const submissionId = typeof doc.submissionId === "string" ? doc.submissionId : "";
    const base = { partyId, submissionId };
    if (!partyId || !submissionId) {
      return { ...base, action: "skip_conflict" as const, reason: "Doc is missing party/submission identity; refusing to stamp." };
    }
    if (doc.status === "withdrawn" || doc.tombstone === true) {
      return { ...base, action: "skip_withdrawn" as const, reason: "Withdrawn/tombstoned docs are never re-stamped or reset." };
    }
    const derived = provenanceFromGuestMediaDoc(doc, "server:migration", nowIso);
    if (!derived) {
      const unknown = provenanceUnknown(partyId, typeof doc.channelId === "string" ? doc.channelId : undefined, `unknown:${submissionId}`, nowIso);
      void unknown;
      return { ...base, action: "leave_unknown" as const, reason: "No recorded accepted supported consent; unknown stays unknown." };
    }
    if (sameProvenanceBinding(doc.provenance, derived)) {
      return { ...base, action: "already_current" as const, reason: "Provenance already matches recorded evidence; idempotent no-op." };
    }
    return { ...base, action: "stamp_provenance" as const, reason: "Stamping guest_mobile provenance from recorded consent evidence.", provenance: derived };
  });
}

/**
 * Pure apply over one doc: returns the updated doc plus whether it changed.
 * Fails closed on fresh-state conflicts and NEVER:
 * - fabricates accepted consent,
 * - resets status/withdrawn/tombstone/withdrawnAt,
 * - alters deleteAt/expiresAt retention deadlines,
 * - alters consent/attestation/revision/hash evidence.
 * Only the additive `provenance` field is written.
 */
export function applyProvenanceRecord(
  fresh: Record<string, unknown>,
  planned: MigrationPlanEntry,
): { doc: Record<string, unknown>; changed: boolean; conflict?: string } {
  if (planned.action !== "stamp_provenance" || !planned.provenance) {
    return { doc: { ...fresh }, changed: false };
  }
  if (fresh.partyId !== planned.partyId || fresh.submissionId !== planned.submissionId) {
    return { doc: { ...fresh }, changed: false, conflict: "Fresh doc identity differs from plan; refusing to stamp." };
  }
  if (fresh.status === "withdrawn" || fresh.tombstone === true) {
    return { doc: { ...fresh }, changed: false, conflict: "Fresh state is withdrawn/tombstoned; never resetting." };
  }
  const consent = fresh.consent;
  if (!isRecord(consent) || consent.accepted !== true) {
    return { doc: { ...fresh }, changed: false, conflict: "Fresh state carries no accepted consent; refusing to fabricate acceptance." };
  }
  if (typeof fresh.consentRevision === "string" && typeof planned.provenance.revision === "string") {
    const freshRev = fresh.consentRevision as string;
    if (planned.provenance.revision !== freshRev) {
      // Revision drift since planning: recompute from fresh evidence instead
      // of stamping a stale binding; if fresh evidence no longer supports
      // provenance, leave the doc untouched.
      const recomputed = provenanceFromGuestMediaDoc(fresh, "server:migration", planned.provenance.recordedAt);
      if (!recomputed) {
        return { doc: { ...fresh }, changed: false, conflict: "Fresh consent evidence no longer supports provenance; leaving unknown." };
      }
      if (sameProvenanceBinding(fresh.provenance, recomputed)) {
        return { doc: { ...fresh }, changed: false };
      }
      return { doc: { ...fresh, provenance: recomputed }, changed: true };
    }
  }
  if (sameProvenanceBinding(fresh.provenance, planned.provenance)) {
    return { doc: { ...fresh }, changed: false };
  }
  return { doc: { ...fresh, provenance: { ...planned.provenance } }, changed: true };
}

interface Options {
  target: "emulator" | "cloud";
  project?: string;
  party: string;
  submission?: string;
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
    if (!match) fail(`Unknown migration argument ${arg}; use --name=value and opt into writes with --apply.`);
    values[match[1]] = match[2];
  }
  const target = values.target as Options["target"] | undefined;
  if (target !== "emulator" && target !== "cloud") fail("Migration requires explicit --target=emulator or --target=cloud.");
  const party = values.party ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(party)) fail("Migration requires an explicit --party scope; refusing unscoped writes.");
  const submission = values.submission;
  if (submission !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(submission)) fail("submission scope is invalid.");
  return { target, project: values.project, party, submission, apply };
}

function selectProject(options: Options): string {
  const firestoreEmulator = process.env.FIRESTORE_EMULATOR_HOST;
  if (options.target === "emulator") {
    if (!firestoreEmulator) fail("Emulator migration requires FIRESTORE_EMULATOR_HOST.");
    if (options.apply && options.project && !options.project.startsWith("demo-")) {
      fail("Emulator apply requires a demo project ID.");
    }
    return options.project ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "demo-halloween-tv";
  }
  if (firestoreEmulator || process.env.STORAGE_EMULATOR_HOST) {
    fail("Cloud migration refuses emulator environment variables; clear them first.");
  }
  if (!options.project) fail("Cloud migration requires an explicit --project=PROJECT flag.");
  if (options.project.startsWith("demo-")) fail("Cloud migration target cannot use a demo project ID.");
  return options.project;
}

async function loadScope(db: Firestore, options: Options): Promise<Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }>> {
  const collection = db.collection(`parties/${options.party}/guestMedia`);
  const snapshot = options.submission
    ? await collection.where("submissionId", "==", options.submission).get()
    : await collection.get();
  return snapshot.docs.map((doc) => ({ ref: doc.ref, data: doc.data() as Record<string, unknown> }));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const projectId = selectProject(options);
  const nowIso = new Date().toISOString();
  if (options.target === "cloud" && !options.apply) {
    // Cloud preview still needs read access; fall through to planned preview.
  }
  const app = initializeApp({ projectId }, `migrate-provenance-${Date.now()}`);
  try {
    const db = getFirestore(app);
    const scoped = await loadScope(db, options);
    const plan = planProvenanceMigration(scoped.map((entry) => entry.data), nowIso);
    if (!options.apply) {
      process.stdout.write(`${JSON.stringify({ result: "preview", applied: false, party: options.party, entries: plan })}\n`);
      return;
    }
    let stamped = 0;
    let skipped = 0;
    let conflicts = 0;
    for (let index = 0; index < scoped.length; index += 1) {
      const planned = plan[index];
      if (planned.action !== "stamp_provenance" || !planned.provenance) {
        skipped += 1;
        continue;
      }
      const { ref } = scoped[index];
      try {
        const outcome = await db.runTransaction(async (transaction) => {
          const freshSnap = await transaction.get(ref);
          if (!freshSnap.exists) return "conflict";
          const applied = applyProvenanceRecord(freshSnap.data() as Record<string, unknown>, planned);
          if (applied.conflict) return "conflict";
          if (!applied.changed) return "noop";
          transaction.update(ref, {
            provenance: applied.doc.provenance,
            updatedAt: FieldValue.serverTimestamp(),
          });
          return "stamped";
        });
        if (outcome === "stamped") stamped += 1;
        else if (outcome === "conflict") conflicts += 1;
        else skipped += 1;
      } catch {
        conflicts += 1;
      }
    }
    process.stdout.write(`${JSON.stringify({ result: "migrated", applied: true, party: options.party, stamped, skipped, conflicts })}\n`);
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

export { PROVENANCE_VERSION as MIGRATION_PROVENANCE_VERSION };
