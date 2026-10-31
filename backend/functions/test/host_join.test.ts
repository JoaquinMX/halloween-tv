import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Timestamp } from "firebase-admin/firestore";
import { BackendError } from "../src/contracts";
import { createHostJoinService, hashHostInviteToken } from "../src/host_join";
import { createJoinPartyService } from "../src/join_party";
import { assertRegisteredHostDevice } from "../src/auth";
import {
  HAS_FIRESTORE_EMULATOR,
  clearParty,
  createEmulatorContext,
  disposeEmulatorContext,
  randomPartyId,
  seedParty,
} from "./support/emulators";

async function seedTv(db: FirebaseFirestore.Firestore, partyId: string, deviceId: string, channelId: string): Promise<void> {
  await seedParty(db, partyId, deviceId, channelId);
  await db.doc(`parties/${partyId}/devices/${deviceId}`).update({ role: "tv" });
}

test("join_roles fixture pins the guest/host role boundary (shape only; behaviour is covered by emulator tests)", async () => {
  const content = await readFile(resolve(__dirname, "../../../test/fixtures/join_roles_v1.json"), "utf8");
  const roles = JSON.parse(content) as {
    callables: string[];
    guestJoin: { request: Record<string, unknown>; response: Record<string, unknown> };
    hostJoin: { request: Record<string, unknown>; response: Record<string, unknown> };
    createHostInvite: { response: Record<string, unknown> };
  };
  assert.deepEqual(roles.callables, ["createHostInvite", "joinHost", "revokeHostDevice", "listHostVideos", "generateHostVideo", "getHostVideoPreview", "deleteHostVideo"]);
  // The fixture PIN is an obviously-fake placeholder, never a live credential.
  assert.equal(roles.guestJoin.request.joinPin, "000000");
  assert.match(String(roles.guestJoin.request.joinPin), /^[0-9]{6}$/);
  // The host route carries a server-minted capability plus a 6-digit pairing
  // code (never a bare guest PIN shape for the token itself).
  assert.ok(String(roles.hostJoin.request.inviteToken).length > 0);
  assert.ok(!/^[0-9]{6}$/.test(String(roles.hostJoin.request.inviteToken)));
  assert.ok("pairingCode" in roles.hostJoin.request);
  assert.ok("pairingCode" in roles.createHostInvite.response);
  // Behavioural role-boundary coverage lives in the emulator tests below, not
  // in this JSON: guest joins yield role guest, host redemptions yield role
  // host, and the two routes are disjoint server-side.
});

test("guest and host routes produce disjoint server-assigned roles (behavioural)", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedTv(db, partyId, "tv-1", "main");
    const hosts = createHostJoinService({ db });
    const joinParty = createJoinPartyService({ db });
    const guest = await joinParty.joinParty({ partyId, deviceId: "p-guest-1", channelId: "main" });
    assert.equal(guest.role, "guest");
    const invite = await hosts.createHostInvite({ partyId, deviceId: "tv-1", channelId: "main" });
    const joined = await hosts.joinHost({
      partyId, deviceId: "p-host-1", channelId: "main",
      inviteToken: invite.inviteToken, pairingCode: invite.pairingCode,
    });
    assert.equal(joined.role, "host");
    assert.notEqual(guest.role, joined.role);
    assert.equal((await db.doc(`parties/${partyId}/devices/p-guest-1`).get()).data()?.role, "guest");
    assert.equal((await db.doc(`parties/${partyId}/devices/p-host-1`).get()).data()?.role, "host");
  } finally {
    await db.recursiveDelete(db.doc(`parties/${partyId}`)).catch(() => undefined);
    await disposeEmulatorContext(app);
  }
});

test("only a registered TV may mint a host invite; invites bind party/channel/expiry", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedTv(db, partyId, "tv-1", "main");
    await seedParty(db, partyId, "p-guest-1", "main");
    const services = createHostJoinService({ db });
    const invite = await services.createHostInvite({ partyId, deviceId: "tv-1", channelId: "main" });
    assert.equal(invite.partyId, partyId);
    assert.equal(invite.channelId, "main");
    assert.ok(invite.inviteToken.startsWith("hi-"));
    assert.match(invite.pairingCode, /^[0-9]{6}$/);
    assert.ok(Date.parse(invite.expiresAt) > Date.now());
    // Only hashes are stored, bound to party/channel/expiry; neither secret
    // appears in the stored doc.
    const tokenHash = hashHostInviteToken(invite.inviteToken);
    const stored = (await db.doc(`parties/${partyId}/hostInvites/${tokenHash.slice(0, 32)}`).get()).data()!;
    assert.equal(stored.tokenHash, tokenHash);
    assert.equal(stored.partyId, partyId);
    assert.equal(stored.channelId, "main");
    assert.equal(stored.status, "pending");
    assert.ok(typeof stored.pairingCodeHash === "string" && typeof stored.pairingSalt === "string");
    assert.ok(!("inviteToken" in stored) && !JSON.stringify(stored).includes(invite.inviteToken));
    assert.ok(!JSON.stringify(stored).includes(invite.pairingCode), "pairing code is never stored in cleartext");
    // Guests, unknown devices, and wrong channels cannot mint invites.
    await assert.rejects(services.createHostInvite({ partyId, deviceId: "p-guest-1", channelId: "main" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    await assert.rejects(services.createHostInvite({ partyId, deviceId: "nope", channelId: "main" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    await assert.rejects(services.createHostInvite({ partyId, deviceId: "tv-1", channelId: "other" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});

test("host redemption is transactional: idempotent retry, replay/expiry/PIN/role forgery denied", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedTv(db, partyId, "tv-1", "main");
    const services = createHostJoinService({ db });
    const invite = await services.createHostInvite({ partyId, deviceId: "tv-1", channelId: "main" });
    const redeem = { partyId, channelId: "main", inviteToken: invite.inviteToken, pairingCode: invite.pairingCode };

    const joined = await services.joinHost({ ...redeem, deviceId: "p-host-1" });
    assert.deepEqual(joined, { partyId, deviceId: "p-host-1", channelId: "main", role: "host", status: "active", created: true });
    const device = (await db.doc(`parties/${partyId}/devices/p-host-1`).get()).data()!;
    assert.equal(device.role, "host");
    assert.equal(device.status, "active");
    assert.equal(typeof device.redeemedFromInviteId, "string");
    assert.ok(device.redeemedAt, "redemption records redeemedAt on the device doc");

    // Same-device redemption retries are idempotent.
    const retried = await services.joinHost({ ...redeem, deviceId: "p-host-1" });
    assert.equal(retried.created, false);
    assert.equal(retried.role, "host");

    // Other-device replay of the same token cannot grant host access.
    await assert.rejects(services.joinHost({ ...redeem, deviceId: "p-host-2" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    assert.equal((await db.doc(`parties/${partyId}/devices/p-host-2`).get()).exists, false);

    // Guest PIN reuse cannot grant host access (shape-rejected, never redeemed).
    await assert.rejects(services.joinHost({ partyId, deviceId: "p-host-3", channelId: "main", inviteToken: "004201", pairingCode: invite.pairingCode }),
      (e: unknown) => e instanceof BackendError);
    assert.equal((await db.doc(`parties/${partyId}/devices/p-host-3`).get()).exists, false);

    // Client-only role changes cannot grant host access: a forged role field
    // is ignored and a guest-PIN registration stays a guest.
    const joinParty = createJoinPartyService({ db });
    const guest = await joinParty.joinParty({ partyId, deviceId: "p-guest-9", channelId: "main", role: "host" } as unknown as Record<string, unknown>);
    assert.equal(guest.role, "guest");
    assert.equal((await db.doc(`parties/${partyId}/devices/p-guest-9`).get()).data()?.role, "guest");
    await assert.rejects(services.joinHost({ ...redeem, deviceId: "p-guest-9" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");

    // Expired invites are refused.
    const invite2 = await services.createHostInvite({ partyId, deviceId: "tv-1", channelId: "main" });
    const tokenHash2 = hashHostInviteToken(invite2.inviteToken);
    await db.doc(`parties/${partyId}/hostInvites/${tokenHash2.slice(0, 32)}`).update({ expiresAt: Timestamp.fromDate(new Date(Date.now() - 1000)) });
    await assert.rejects(services.joinHost({
      partyId, deviceId: "p-host-4", channelId: "main",
      inviteToken: invite2.inviteToken, pairingCode: invite2.pairingCode,
    }), (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");

    // Cross-party token reuse is refused.
    const otherParty = randomPartyId();
    await seedTv(db, otherParty, "tv-9", "main");
    await assert.rejects(services.joinHost({ ...redeem, partyId: otherParty, deviceId: "p-host-5" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    await db.recursiveDelete(db.doc(`parties/${otherParty}`)).catch(() => undefined);
  } finally {
    await db.recursiveDelete(db.doc(`parties/${partyId}`)).catch(() => undefined);
    await disposeEmulatorContext(app);
  }
});

test("pairing code is required and wrong codes deny exactly like an unknown invite", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedTv(db, partyId, "tv-1", "main");
    const services = createHostJoinService({ db });
    const invite = await services.createHostInvite({ partyId, deviceId: "tv-1", channelId: "main" });
    assert.match(invite.pairingCode, /^[0-9]{6}$/);

    const probe = async (body: Record<string, unknown>): Promise<BackendError> =>
      services.joinHost(body).then(
        () => { throw new Error("expected rejection"); },
        (error: unknown) => error as BackendError,
      );
    // Missing, malformed, and wrong codes all deny with the SAME generic
    // error as an unknown invite: no oracle for code-vs-token probing.
    const unknown = await probe({ partyId, deviceId: "p-x", channelId: "main", inviteToken: "hi-deadbeef", pairingCode: "000000" });
    assert.ok(unknown instanceof BackendError && unknown.errorCode === "FORBIDDEN");
    for (const pairingCode of [undefined, "", "12345", "1234567", "abcdef", "12 456", 4201, null]) {
      const denied = await probe({ partyId, deviceId: "p-x", channelId: "main", inviteToken: invite.inviteToken, pairingCode });
      assert.ok(denied instanceof BackendError && denied.errorCode === "FORBIDDEN", `code ${String(pairingCode)} must deny`);
      assert.equal(denied.message, unknown.message, "denial message must be identical (no oracle)");
    }
    const wrongCode = String((Number(invite.pairingCode) + 1) % 1_000_000).padStart(6, "0");
    const wrong = await probe({ partyId, deviceId: "p-x", channelId: "main", inviteToken: invite.inviteToken, pairingCode: wrongCode });
    assert.ok(wrong instanceof BackendError && wrong.errorCode === "FORBIDDEN");
    assert.equal(wrong.message, unknown.message, "wrong code must deny identically to an unknown invite");
    assert.equal((await db.doc(`parties/${partyId}/devices/p-x`).get()).exists, false);
    // The correct half still redeems afterwards (wrong guesses do not burn it).
    const joined = await services.joinHost({
      partyId, deviceId: "p-host-ok", channelId: "main",
      inviteToken: invite.inviteToken, pairingCode: invite.pairingCode,
    });
    assert.equal(joined.role, "host");
  } finally {
    await db.recursiveDelete(db.doc(`parties/${partyId}`)).catch(() => undefined);
    await disposeEmulatorContext(app);
  }
});

test("minting a new invite supersedes older pending invites for the same channel", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedTv(db, partyId, "tv-1", "main");
    const services = createHostJoinService({ db });
    const first = await services.createHostInvite({ partyId, deviceId: "tv-1", channelId: "main" });
    const second = await services.createHostInvite({ partyId, deviceId: "tv-1", channelId: "main" });
    assert.notEqual(first.inviteToken, second.inviteToken);
    const firstStored = (await db.doc(`parties/${partyId}/hostInvites/${hashHostInviteToken(first.inviteToken).slice(0, 32)}`).get()).data()!;
    assert.equal(firstStored.status, "superseded", "older pending invite must be invalidated by the new mint");
    // The superseded invite can no longer redeem, even with its own code.
    await assert.rejects(services.joinHost({
      partyId, deviceId: "p-host-old", channelId: "main",
      inviteToken: first.inviteToken, pairingCode: first.pairingCode,
    }), (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    // The newest invite redeems normally.
    const joined = await services.joinHost({
      partyId, deviceId: "p-host-new", channelId: "main",
      inviteToken: second.inviteToken, pairingCode: second.pairingCode,
    });
    assert.equal(joined.created, true);
  } finally {
    await db.recursiveDelete(db.doc(`parties/${partyId}`)).catch(() => undefined);
    await disposeEmulatorContext(app);
  }
});

test("at most 3 active host devices per party; revocation frees capacity with an audit record", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedTv(db, partyId, "tv-1", "main");
    const services = createHostJoinService({ db });
    const redeem = async (deviceId: string) => {
      const invite = await services.createHostInvite({ partyId, deviceId: "tv-1", channelId: "main" });
      return services.joinHost({
        partyId, deviceId, channelId: "main",
        inviteToken: invite.inviteToken, pairingCode: invite.pairingCode,
      });
    };
    for (const deviceId of ["p-host-1", "p-host-2", "p-host-3"]) {
      const joined = await redeem(deviceId);
      assert.equal(joined.created, true);
    }
    // Fourth redemption is denied until a host is revoked.
    const fourth = await services.createHostInvite({ partyId, deviceId: "tv-1", channelId: "main" });
    await assert.rejects(services.joinHost({
      partyId, deviceId: "p-host-4", channelId: "main",
      inviteToken: fourth.inviteToken, pairingCode: fourth.pairingCode,
    }), (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    assert.equal((await db.doc(`parties/${partyId}/devices/p-host-4`).get()).exists, false);

    // TV-only revocation: guests and strangers cannot revoke.
    await assert.rejects(services.revokeHostDevice({ partyId, deviceId: "p-host-1", channelId: "main", targetDeviceId: "p-host-2" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    await assert.rejects(services.revokeHostDevice({ partyId, deviceId: "nope", channelId: "main", targetDeviceId: "p-host-2" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");

    // The TV revokes one host: device demoted, audit record written.
    const revoked = await services.revokeHostDevice({ partyId, deviceId: "tv-1", channelId: "main", targetDeviceId: "p-host-2" });
    assert.deepEqual(revoked, { partyId, targetDeviceId: "p-host-2", status: "revoked" });
    assert.equal((await db.doc(`parties/${partyId}/devices/p-host-2`).get()).data()?.status, "revoked");
    const audits = await db.collection(`parties/${partyId}/hostAudit`).where("targetDeviceId", "==", "p-host-2").get();
    assert.equal(audits.size, 1, "revocation must write exactly one audit record");
    assert.equal(audits.docs[0].data()?.action, "revoke");
    assert.equal(audits.docs[0].data()?.byDeviceId, "tv-1");

    // The revoked host is denied on its next admin operation.
    await assert.rejects(assertRegisteredHostDevice(db, { partyId, deviceId: "p-host-2", channelId: "main" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");

    // Capacity freed: the fourth phone redeems with a fresh invite.
    const fifth = await services.createHostInvite({ partyId, deviceId: "tv-1", channelId: "main" });
    const rejoined = await services.joinHost({
      partyId, deviceId: "p-host-4", channelId: "main",
      inviteToken: fifth.inviteToken, pairingCode: fifth.pairingCode,
    });
    assert.equal(rejoined.created, true);
    assert.equal(rejoined.role, "host");
  } finally {
    await db.recursiveDelete(db.doc(`parties/${partyId}`)).catch(() => undefined);
    await disposeEmulatorContext(app);
  }
});

test("legacy joinParty remains guest-only and never upgrades host devices", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db } = await createEmulatorContext();
  const partyId = randomPartyId();
  try {
    await seedTv(db, partyId, "tv-1", "main");
    const hosts = createHostJoinService({ db });
    const joinParty = createJoinPartyService({ db });
    const invite = await hosts.createHostInvite({ partyId, deviceId: "tv-1", channelId: "main" });
    await hosts.joinHost({
      partyId, deviceId: "p-host-1", channelId: "main",
      inviteToken: invite.inviteToken, pairingCode: invite.pairingCode,
    });
    // A host device rejoining through the legacy path is rejected, not downgraded.
    await assert.rejects(joinParty.joinParty({ partyId, deviceId: "p-host-1", channelId: "main" }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    assert.equal((await db.doc(`parties/${partyId}/devices/p-host-1`).get()).data()?.role, "host");
    // Fresh legacy joins are still guests.
    const guest = await joinParty.joinParty({ partyId, deviceId: "p-new-guest", channelId: "main" });
    assert.equal(guest.role, "guest");
  } finally {
    await db.recursiveDelete(db.doc(`parties/${partyId}`)).catch(() => undefined);
    await disposeEmulatorContext(app);
  }
});
