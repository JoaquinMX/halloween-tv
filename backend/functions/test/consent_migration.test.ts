import assert from "node:assert/strict";
import test from "node:test";
import { canDeliverSeedArtifact, canGenerateFromPortrait, provenanceFromSeedEntry } from "../src/consent_provenance";
import { CREATES_GUEST_CONSENT as PILOT_CREATES_CONSENT, SEED_PILOT_WRITABLE_COLLECTIONS } from "../tools/seed_pilot";
import { CREATES_GUEST_CONSENT as GUESTS_CREATES_CONSENT } from "../tools/seed_guests";
import {
  applyProvenanceRecord,
  planProvenanceMigration,
  type MigrationPlanEntry,
} from "../tools/migrate_consent_provenance";

const NOW_ISO = new Date().toISOString();
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const HASH = "c".repeat(64);

function eligibleDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    submissionId: "gsub-mig000000000000000000000001",
    partyId: "party-mig",
    deviceId: "guest-1",
    channelId: "main",
    status: "eligible",
    consent: {
      accepted: true,
      textVersion: "v1",
      purpose: "guest_cameo",
      acceptedAt: new Date(Date.now() - 1000).toISOString(),
      deviceId: "guest-1",
    },
    consentRevision: "v1:accepted",
    objectPath: "parties/party-mig/guests/guest-1/ingest/gsub-mig000000000000000000000001/photo.jpg",
    sourceHash: HASH,
    sourceSizeBytes: 1234,
    expiresAt: FUTURE,
    deleteAt: FUTURE,
    createdAt: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  };
}

test("migration preview is read-only and explicitly scoped", () => {
  const docs = [eligibleDoc()];
  const before = JSON.parse(JSON.stringify(docs));
  const plan = planProvenanceMigration(docs, NOW_ISO);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "stamp_provenance");
  assert.deepEqual(docs, before, "planning must never mutate its inputs");
  assert.equal(plan[0].partyId, "party-mig");
});

test("eligible history stamps guest_mobile provenance preserving original evidence", () => {
  const fixture = eligibleDoc();
  const [entry] = planProvenanceMigration([fixture], NOW_ISO);
  assert.equal(entry.action, "stamp_provenance");
  const provenance = entry.provenance!;
  assert.equal(provenance.origin, "guest_mobile");
  assert.equal(provenance.evidenceSource, "server:migration");
  assert.equal(provenance.actorDeviceId, "guest-1");
  assert.deepEqual(provenance.purposes, ["v1:guest_cameo"]);
  assert.equal(provenance.sourceHash, HASH);
  assert.equal(provenance.revision, "v1:accepted");
  const applied = applyProvenanceRecord(fixture, entry);
  assert.equal(applied.changed, true);
  // Original evidence is preserved verbatim; retention deadlines untouched.
  assert.deepEqual(applied.doc.consent, fixture.consent);
  assert.equal(applied.doc.consentRevision, "v1:accepted");
  assert.equal(applied.doc.sourceHash, HASH);
  assert.equal(applied.doc.expiresAt, FUTURE);
  assert.equal(applied.doc.deleteAt, FUTURE);
  assert.equal(applied.doc.status, "eligible");
  assert.equal((applied.doc.consent as Record<string, unknown>).accepted, true);
});

test("migration apply is idempotent", () => {
  const docs = [eligibleDoc()];
  const [entry] = planProvenanceMigration(docs, NOW_ISO);
  const first = applyProvenanceRecord(docs[0], entry);
  assert.equal(first.changed, true);
  const second = applyProvenanceRecord(first.doc, entry);
  assert.equal(second.changed, false, "second apply must be a no-op");
  assert.deepEqual(second.doc, first.doc);
  const replan = planProvenanceMigration([first.doc], NOW_ISO);
  assert.equal(replan[0].action, "already_current");
});

test("withdrawal, tombstones, and retention deadlines are never reset", () => {
  const withdrawn = eligibleDoc({ status: "withdrawn", tombstone: true, withdrawnAt: new Date().toISOString() });
  const [planned] = planProvenanceMigration([withdrawn], NOW_ISO);
  assert.equal(planned.action, "skip_withdrawn");
  // Even a stale stamp plan against fresh withdrawn state conflicts closed.
  const stale: MigrationPlanEntry = {
    partyId: "party-mig",
    submissionId: withdrawn.submissionId as string,
    action: "stamp_provenance",
    reason: "stale",
    provenance: { ...(planProvenanceMigration([eligibleDoc()], NOW_ISO)[0].provenance!) },
  };
  const outcome = applyProvenanceRecord(withdrawn, stale);
  assert.equal(outcome.changed, false);
  assert.ok(outcome.conflict);
  assert.equal(outcome.doc.status, "withdrawn");
  assert.equal(outcome.doc.tombstone, true);
  assert.equal(outcome.doc.deleteAt, FUTURE, "retention deadline must survive");
});

test("unknown historical provenance stays unknown; no synthetic acceptance", () => {
  const noConsent = eligibleDoc({ status: "pending_upload", consent: undefined, sourceHash: undefined, consentRevision: undefined });
  const [entry] = planProvenanceMigration([noConsent], NOW_ISO);
  assert.equal(entry.action, "leave_unknown");
  assert.equal(entry.provenance, undefined);
  const applied = applyProvenanceRecord(noConsent, entry);
  assert.equal(applied.changed, false);
  assert.equal((applied.doc as Record<string, unknown>).consent, undefined, "no synthetic consent may be written");
  const unsupported = eligibleDoc({
    consent: { accepted: true, textVersion: "v9", purpose: "other", acceptedAt: NOW_ISO, deviceId: "guest-1" },
  });
  const [unsupportedEntry] = planProvenanceMigration([unsupported], NOW_ISO);
  assert.equal(unsupportedEntry.action, "leave_unknown", "unsupported namespaces stay unknown");
});

test("explicitly approved legacy delivery needs no synthetic guestMedia", () => {
  // Legacy delivery permission lives on the seed catalog entry, not on a
  // guestMedia doc: no migration output is required for it.
  const plan = planProvenanceMigration([], NOW_ISO);
  assert.deepEqual(plan, [], "no docs means no synthetic records");
  const seed = provenanceFromSeedEntry(
    { partyId: "party-mig", channelId: "main", seedId: "legacy-9", status: "ready" },
    { deliveryApproved: true, evidenceSource: "server:seed_catalog", recordedAtIso: NOW_ISO },
  );
  const scope = { partyId: "party-mig", channelId: "main", nowMs: Date.now() };
  assert.equal(canDeliverSeedArtifact(seed, scope), true);
  assert.equal(canGenerateFromPortrait(seed, { ...scope, deviceId: "guest-1" }), false);
});

test("fresh-state conflicts fail closed instead of overwriting", () => {
  const [entry] = planProvenanceMigration([eligibleDoc()], NOW_ISO);
  // Identity drift since planning: refuse.
  const wrongIdentity = applyProvenanceRecord(eligibleDoc({ submissionId: "gsub-other00000000000000000000001" }), entry);
  assert.equal(wrongIdentity.changed, false);
  assert.ok(wrongIdentity.conflict);
  // Consent removed since planning: refuse to fabricate.
  const consentGone = applyProvenanceRecord(eligibleDoc({ consent: { accepted: false } }), entry);
  assert.equal(consentGone.changed, false);
  assert.ok(consentGone.conflict);
  // Revision drift with matching hash recomputes from fresh evidence.
  const drifted = eligibleDoc({ consentRevision: "v1:rotated", sourceHash: HASH });
  const driftOutcome = applyProvenanceRecord(drifted, entry);
  assert.equal(driftOutcome.changed, true);
  assert.equal((driftOutcome.doc.provenance as Record<string, unknown>).revision, "v1:rotated");
});

test("device registration seeding never creates guest consent", () => {
  assert.equal(PILOT_CREATES_CONSENT, false);
  assert.equal(GUESTS_CREATES_CONSENT, false);
  assert.ok(!(SEED_PILOT_WRITABLE_COLLECTIONS as readonly string[]).includes("guestMedia"));
  assert.ok(!(SEED_PILOT_WRITABLE_COLLECTIONS as readonly string[]).includes("guest_media"));
});
