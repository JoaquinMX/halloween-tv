import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Timestamp } from "firebase-admin/firestore";
import { BackendError } from "../src/contracts";
import { createHostJoinService, hashHostInviteToken } from "../src/host_join";
import { createJoinPartyService } from "../src/join_party";
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

test("join_roles fixture matches the enforced guest/host role boundary", async () => {
  const content = await readFile(resolve(__dirname, "../../../test/fixtures/join_roles_v1.json"), "utf8");
  const roles = JSON.parse(content) as {
    callables: string[];
    guestJoin: { request: Record<string, unknown>; response: Record<string, unknown> };
    hostJoin: { request: Record<string, unknown>; response: Record<string, unknown> };
  };
  assert.deepEqual(roles.callables, ["createHostInvite", "joinHost", "listHostVideos", "generateHostVideo", "getHostVideoPreview", "deleteHostVideo"]);
  // The guest route and the host route produce disjoint server-assigned roles.
  assert.equal(roles.guestJoin.response.role, "guest");
  assert.equal(roles.hostJoin.response.role, "host");
  assert.notEqual(roles.guestJoin.response.role, roles.hostJoin.response.role);
  // The guest fixture carries a six-digit PIN (redeemed via joinParty); the
  // host fixture carries a server-minted capability (never a PIN shape).
  assert.match(String((roles.guestJoin.request as Record<string, unknown>).joinPin), /^[0-9]{6}$/);
  assert.ok(String((roles.hostJoin.request as Record<string, unknown>).inviteToken).length > 0);
  // A host token is never a bare guest PIN: PIN-shaped strings are rejected
  // as invite tokens by the parser (covered behaviorally above).
  assert.ok(!/^[0-9]{6}$/.test(String((roles.hostJoin.request as Record<string, unknown>).inviteToken)));
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
    assert.ok(Date.parse(invite.expiresAt) > Date.now());
    // Only the token hash is stored, bound to party/channel/expiry.
    const tokenHash = hashHostInviteToken(invite.inviteToken);
    const stored = (await db.doc(`parties/${partyId}/hostInvites/${tokenHash.slice(0, 32)}`).get()).data()!;
    assert.equal(stored.tokenHash, tokenHash);
    assert.equal(stored.partyId, partyId);
    assert.equal(stored.channelId, "main");
    assert.equal(stored.status, "pending");
    assert.ok(!("inviteToken" in stored) && !JSON.stringify(stored).includes(invite.inviteToken));
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

    const joined = await services.joinHost({ partyId, deviceId: "p-host-1", channelId: "main", inviteToken: invite.inviteToken });
    assert.deepEqual(joined, { partyId, deviceId: "p-host-1", channelId: "main", role: "host", status: "active", created: true });
    const device = (await db.doc(`parties/${partyId}/devices/p-host-1`).get()).data()!;
    assert.equal(device.role, "host");
    assert.equal(device.status, "active");

    // Same-device redemption retries are idempotent.
    const retried = await services.joinHost({ partyId, deviceId: "p-host-1", channelId: "main", inviteToken: invite.inviteToken });
    assert.equal(retried.created, false);
    assert.equal(retried.role, "host");

    // Other-device replay of the same token cannot grant host access.
    await assert.rejects(services.joinHost({ partyId, deviceId: "p-host-2", channelId: "main", inviteToken: invite.inviteToken }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    assert.equal((await db.doc(`parties/${partyId}/devices/p-host-2`).get()).exists, false);

    // Guest PIN reuse cannot grant host access (shape-rejected, never redeemed).
    await assert.rejects(services.joinHost({ partyId, deviceId: "p-host-3", channelId: "main", inviteToken: "004201" }),
      (e: unknown) => e instanceof BackendError);
    assert.equal((await db.doc(`parties/${partyId}/devices/p-host-3`).get()).exists, false);

    // Client-only role changes cannot grant host access: a forged role field
    // is ignored and a guest-PIN registration stays a guest.
    const joinParty = createJoinPartyService({ db });
    const guest = await joinParty.joinParty({ partyId, deviceId: "p-guest-9", channelId: "main", role: "host" } as unknown as Record<string, unknown>);
    assert.equal(guest.role, "guest");
    assert.equal((await db.doc(`parties/${partyId}/devices/p-guest-9`).get()).data()?.role, "guest");
    await assert.rejects(services.joinHost({ partyId, deviceId: "p-guest-9", channelId: "main", inviteToken: invite.inviteToken }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");

    // Expired invites are refused.
    const invite2 = await services.createHostInvite({ partyId, deviceId: "tv-1", channelId: "main" });
    const tokenHash2 = hashHostInviteToken(invite2.inviteToken);
    await db.doc(`parties/${partyId}/hostInvites/${tokenHash2.slice(0, 32)}`).update({ expiresAt: Timestamp.fromDate(new Date(Date.now() - 1000)) });
    await assert.rejects(services.joinHost({ partyId, deviceId: "p-host-4", channelId: "main", inviteToken: invite2.inviteToken }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");

    // Cross-party token reuse is refused.
    const otherParty = randomPartyId();
    await seedTv(db, otherParty, "tv-9", "main");
    await assert.rejects(services.joinHost({ partyId: otherParty, deviceId: "p-host-5", channelId: "main", inviteToken: invite.inviteToken }),
      (e: unknown) => e instanceof BackendError && e.errorCode === "FORBIDDEN");
    await db.recursiveDelete(db.doc(`parties/${otherParty}`)).catch(() => undefined);
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
    await hosts.joinHost({ partyId, deviceId: "p-host-1", channelId: "main", inviteToken: invite.inviteToken });
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
