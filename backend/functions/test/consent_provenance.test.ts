import assert from "node:assert/strict";
import test from "node:test";
import { BackendError } from "../src/contracts";
import {
  GUEST_MOBILE_PURPOSE,
  HOST_SOURCE_PURPOSE,
  PROVENANCE_VERSION,
  assertCanDeliverSeedArtifact,
  assertCanGenerateFromPortrait,
  assertNoSelfAssertedEscalation,
  assertServerDerived,
  canDeliverSeedArtifact,
  canGenerateFromPortrait,
  markProvenanceWithdrawn,
  provenanceFromGuestMediaDoc,
  provenanceFromHostApproval,
  provenanceFromOperatorApproval,
  provenanceFromSeedEntry,
  provenanceUnknown,
  validateProvenanceRecord,
  type ProvenanceRecord,
} from "../src/consent_provenance";

const NOW = Date.now();
const FUTURE = new Date(NOW + 60 * 60 * 1000).toISOString();
const PAST = new Date(NOW - 60 * 1000).toISOString();
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function guestDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    submissionId: "gsub-test000000000000000000000001",
    partyId: "party-1",
    deviceId: "guest-1",
    channelId: "main",
    status: "eligible",
    consent: {
      accepted: true,
      textVersion: "v1",
      purpose: "guest_cameo",
      acceptedAt: new Date(NOW - 1000).toISOString(),
      deviceId: "guest-1",
    },
    consentRevision: "v1:accepted",
    objectPath: "parties/party-1/guests/guest-1/ingest/gsub-test000000000000000000000001/photo.jpg",
    sourceHash: HASH_A,
    sourceSizeBytes: 100,
    expiresAt: FUTURE,
    ...overrides,
  };
}

function guestProvenance(overrides: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
  const derived = provenanceFromGuestMediaDoc(guestDoc(), "server:guest_upload", new Date(NOW - 1000).toISOString());
  assert.ok(derived, "fixture guest doc must derive guest_mobile provenance");
  return { ...derived, ...overrides };
}

function legacyApproved(overrides: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
  return {
    version: PROVENANCE_VERSION,
    origin: "legacy_seed",
    actorRole: "system",
    evidenceSource: "server:seed_catalog",
    recordedAt: new Date(NOW - 2000).toISOString(),
    partyId: "party-1",
    channelId: "main",
    purposes: ["seed_delivery"],
    artifactHash: HASH_B,
    revision: "seed:legacy-1",
    expiresAt: FUTURE,
    deliveryApproved: true,
    ...overrides,
  };
}

test("versioned provenance records carry all required fields", () => {
  const record = guestProvenance();
  validateProvenanceRecord(record);
  assert.equal(record.version, PROVENANCE_VERSION);
  assert.equal(record.origin, "guest_mobile");
  assert.equal(record.actorRole, "guest");
  assert.equal(record.actorDeviceId, "guest-1");
  assert.ok(record.evidenceSource.startsWith("server:"));
  assert.ok(Number.isFinite(Date.parse(record.recordedAt)));
  assert.equal(record.partyId, "party-1");
  assert.equal(record.channelId, "main");
  assert.deepEqual(record.purposes, [GUEST_MOBILE_PURPOSE]);
  assert.equal(record.sourceHash, HASH_A);
  assert.ok(record.revision.length > 0);
  assert.equal(record.expiresAt, FUTURE);
  assert.equal(record.withdrawn, undefined);
});

test("delivery permission never grants generation permission", () => {
  const record = legacyApproved();
  const scope = { partyId: "party-1", channelId: "main", nowMs: NOW };
  assert.equal(canDeliverSeedArtifact(record, scope), true);
  // Even with every ambient privilege flag set, legacy delivery approval
  // must not grant new subject-photo generation.
  assert.equal(
    canGenerateFromPortrait(record, { ...scope, deviceId: "guest-1" }, {
      budgetActive: true,
      hasJob: true,
      callerRole: "host",
      legacyMarker: true,
    }),
    false,
  );
  assert.throws(
    () => assertCanGenerateFromPortrait(record, { ...scope, deviceId: "guest-1" }, { budgetActive: true }),
    (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN",
  );
  assert.doesNotThrow(() => assertCanDeliverSeedArtifact(record, scope));
});

test("approved-legacy versus mobile decisions stay separated", () => {
  const scope = { partyId: "party-1", channelId: "main", deviceId: "guest-1", nowMs: NOW };
  const mobile = guestProvenance();
  assert.equal(canGenerateFromPortrait(mobile, scope), true);
  // Guest-mobile provenance is bound to the subject photo, not the seed
  // catalog: it never delivers seed artifacts.
  assert.equal(canDeliverSeedArtifact(mobile, scope), false);
  const legacy = legacyApproved();
  assert.equal(canDeliverSeedArtifact(legacy, scope), true);
  assert.equal(canGenerateFromPortrait(legacy, scope), false);
  // Unknown historical provenance grants nothing either way.
  const unknown = provenanceUnknown("party-1", "main", "unknown:x", new Date(NOW).toISOString());
  assert.equal(canDeliverSeedArtifact(unknown, scope), false);
  assert.equal(canGenerateFromPortrait(unknown, scope), false);
});

test("origins are never interchangeable: unapproved legacy and mismatched namespaces fail", () => {
  const scope = { partyId: "party-1", channelId: "main", deviceId: "guest-1", nowMs: NOW };
  assert.equal(canDeliverSeedArtifact(legacyApproved({ deliveryApproved: false }), scope), false);
  assert.equal(canDeliverSeedArtifact(legacyApproved({ deliveryApproved: undefined }), scope), false);
  // Mixed consent namespaces fail closed.
  const mixed = guestProvenance({ purposes: [GUEST_MOBILE_PURPOSE, HOST_SOURCE_PURPOSE] });
  assert.equal(canGenerateFromPortrait(mixed, scope), false);
  // Unknown purpose pair fails closed.
  const unknownPair = guestProvenance({ purposes: ["v9:other"] });
  assert.equal(canGenerateFromPortrait(unknownPair, scope), false);
  // Host-source pair requires a host actor; guest actor with host pair fails.
  const hostPairAsGuest = guestProvenance({ purposes: [HOST_SOURCE_PURPOSE], actorRole: "guest" });
  assert.equal(canGenerateFromPortrait(hostPairAsGuest, scope), false);
  // Host-source pair with host actor and matching device grants generation.
  const hostPair = guestProvenance({
    purposes: [HOST_SOURCE_PURPOSE],
    actorRole: "host",
    actorDeviceId: "host-1",
  });
  assert.equal(canGenerateFromPortrait(hostPair, { partyId: "party-1", channelId: "main", deviceId: "host-1", nowMs: NOW }), true);
});

test("role and source spoofing are rejected", () => {
  const scope = { partyId: "party-1", channelId: "main", deviceId: "guest-1", nowMs: NOW };
  // Client-asserted guest_mobile never grants generation.
  assert.equal(canGenerateFromPortrait(guestProvenance({ evidenceSource: "client:mobile" }), scope), false);
  assert.throws(() => assertServerDerived(guestProvenance({ evidenceSource: "client:mobile" })),
    (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
  // Escalation without server evidence is rejected.
  const unknown = provenanceUnknown("party-1", "main", "unknown:x", new Date(NOW).toISOString());
  assert.throws(
    () => assertNoSelfAssertedEscalation(unknown, { ...guestProvenance(), evidenceSource: "client:mobile" }),
    (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN",
  );
  // Cross-device and cross-party bindings fail closed.
  assert.equal(canGenerateFromPortrait(guestProvenance(), { ...scope, deviceId: "guest-2" }), false);
  assert.equal(canGenerateFromPortrait(guestProvenance(), { ...scope, partyId: "party-2" }), false);
  assert.equal(canGenerateFromPortrait(guestProvenance(), { ...scope, channelId: "other" }), false);
  // Missing device binding fails closed.
  assert.equal(canGenerateFromPortrait(guestProvenance({ actorDeviceId: undefined }), scope), false);
  // Missing source hash fails closed (unverified bytes).
  assert.equal(canGenerateFromPortrait(guestProvenance({ sourceHash: undefined }), scope), false);
});

test("withdrawal and expiry revoke both delivery and generation", () => {
  const scope = { partyId: "party-1", channelId: "main", deviceId: "guest-1", nowMs: NOW };
  assert.equal(canGenerateFromPortrait(guestProvenance({ withdrawn: true, withdrawnAt: new Date(NOW).toISOString() }), scope), false);
  assert.equal(canDeliverSeedArtifact(legacyApproved({ withdrawn: true }), scope), false);
  assert.equal(canGenerateFromPortrait(guestProvenance({ expiresAt: PAST }), scope), false);
  assert.equal(canDeliverSeedArtifact(legacyApproved({ expiresAt: PAST }), scope), false);
  const withdrawn = markProvenanceWithdrawn(guestProvenance(), new Date(NOW).toISOString());
  assert.equal(withdrawn.withdrawn, true);
  assert.equal(withdrawn.revision, guestProvenance().revision, "original revision evidence is preserved");
  assert.equal(withdrawn.sourceHash, HASH_A, "original hash evidence is preserved");
  assert.deepEqual(withdrawn.purposes, [GUEST_MOBILE_PURPOSE]);
  assert.equal(canGenerateFromPortrait(withdrawn, scope), false);
});

test("operator and host approvals grant delivery only, never generation", () => {
  const scope = { partyId: "party-1", channelId: "main", deviceId: "host-1", nowMs: NOW };
  const operator = provenanceFromOperatorApproval({
    partyId: "party-1", channelId: "main", revision: "op:1",
    recordedAtIso: new Date(NOW - 500).toISOString(), deliveryApproved: true,
  });
  assert.equal(canDeliverSeedArtifact(operator, scope), true);
  assert.equal(canGenerateFromPortrait(operator, scope, { callerRole: "host", budgetActive: true }), false);
  const host = provenanceFromHostApproval({
    partyId: "party-1", channelId: "main", hostDeviceId: "host-1",
    revision: "host:1", recordedAtIso: new Date(NOW - 500).toISOString(), deliveryApproved: true,
  });
  assert.equal(canDeliverSeedArtifact(host, scope), true);
  // Host role alone never grants generation: host_approval origin is not guest_mobile.
  assert.equal(canGenerateFromPortrait(host, scope, { callerRole: "host" }), false);
});

test("seed-derived provenance never carries guest acceptance", () => {
  const seed = provenanceFromSeedEntry(
    { partyId: "party-1", channelId: "main", seedId: "legacy-1", status: "ready" },
    { deliveryApproved: true, evidenceSource: "server:seed_catalog", recordedAtIso: new Date(NOW).toISOString() },
  );
  validateProvenanceRecord(seed);
  assert.equal(seed.origin, "legacy_seed");
  assert.ok(!seed.purposes.includes(GUEST_MOBILE_PURPOSE));
  assert.equal(seed.sourceHash, undefined);
  const unapproved = provenanceFromSeedEntry(
    { partyId: "party-1", seedId: "legacy-2" },
    { deliveryApproved: false, evidenceSource: "server:seed_catalog", recordedAtIso: new Date(NOW).toISOString() },
  );
  assert.equal(canDeliverSeedArtifact(unapproved, { partyId: "party-1", nowMs: NOW }), false);
});

test("malformed provenance records are rejected, never trusted", () => {
  const good = guestProvenance();
  for (const bad of [
    { ...good, version: "provenance/v9" },
    { ...good, origin: "superuser" },
    { ...good, actorRole: "admin" },
    { ...good, evidenceSource: "" },
    { ...good, recordedAt: "not-a-date" },
    { ...good, partyId: "" },
    { ...good, purposes: "v1:guest_cameo" },
    { ...good, sourceHash: "zzz" },
    { ...good, revision: "" },
  ]) {
    assert.throws(() => validateProvenanceRecord(bad),
      (e: unknown) => e instanceof BackendError && e.errorCode === "INVALID_ARGUMENT");
    assert.equal(canGenerateFromPortrait(bad as ProvenanceRecord, { partyId: "party-1", nowMs: NOW }), false);
  }
});

test("channel-scoped grants never match a channel-less scope", () => {
  const scope = { partyId: "party-1", channelId: undefined as unknown as string, deviceId: "guest-1", nowMs: NOW };
  assert.equal(canGenerateFromPortrait(guestProvenance(), scope), false);
  assert.equal(canDeliverSeedArtifact(legacyApproved(), { partyId: "party-1", nowMs: NOW }), false);
});

test("production delivery gate refuses unapproved legacy seeds (deliveryApproved=false)", async () => {
  const { evaluateDeliveryProvenance } = await import("../src/contracts");
  const nowMs = NOW;
  const job = { partyId: "party-1", channelId: "main", jobId: "job-legacy-unapproved", seedProvenance: { seedId: "legacy-2", kind: "legacy" } };
  const seed = { partyId: "party-1", channelId: "main", seedId: "legacy-2", status: "ready" };
  assert.throws(
    () => evaluateDeliveryProvenance({ job, seed, nowMs }),
    (e: unknown) => e instanceof BackendError && (e.errorCode === "FORBIDDEN" || e.errorCode === "MANIFEST_MISMATCH"),
  );
  // The standalone provenance gate agrees: unapproved delivery is refused.
  const unapproved = provenanceFromSeedEntry(
    { partyId: "party-1", channelId: "main", seedId: "legacy-2", status: "ready" },
    { deliveryApproved: false, evidenceSource: "server:seed_catalog", recordedAtIso: new Date(NOW).toISOString() },
  );
  assert.equal(canDeliverSeedArtifact(unapproved, { partyId: "party-1", channelId: "main", nowMs }), false);
});
