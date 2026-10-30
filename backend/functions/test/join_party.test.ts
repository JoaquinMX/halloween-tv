import assert from "node:assert/strict";
import test from "node:test";
import { BackendError } from "../src/contracts";
import { createJoinPartyService } from "../src/join_party";
import { createRuntimeServices } from "../src/runtime";
import {
  HAS_FIRESTORE_EMULATOR,
  createEmulatorContext,
  disposeEmulatorContext,
  randomPartyId,
} from "./support/emulators";

async function seedHost(
  db: FirebaseFirestore.Firestore,
  partyId: string,
  tvDevice: string,
  channelId: string,
  partyExtra: Record<string, unknown> = {},
): Promise<void> {
  await db.doc(`parties/${partyId}`).set({
    ownerUid: null,
    status: "active",
    activeChannelId: channelId,
    ...partyExtra,
  });
  await db.doc(`parties/${partyId}/channels/${channelId}`).set({ partyId, channelId, status: "active" });
  await db.doc(`parties/${partyId}/devices/${tvDevice}`).set({
    partyId, deviceId: tvDevice, label: "TV", role: "tv", status: "active",
  });
}

test("joinParty creates guest once, ignores field overrides, and rejects TV collisions", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const channelId = "main";
  try {
    await seedHost(db, partyId, "tv-host", channelId);
    const services = createRuntimeServices({ db, bucket });

    const first = await services.joinParty({ partyId, deviceId: "p-guest1", channelId });
    assert.equal(first.created, true);
    assert.deepEqual(
      { partyId: first.partyId, deviceId: first.deviceId, channelId: first.channelId, role: first.role, status: first.status },
      { partyId, deviceId: "p-guest1", channelId, role: "guest", status: "active" },
    );
    assert.ok(!("joinPin" in first), "PIN must never be echoed");

    const stored = (await db.doc(`parties/${partyId}/devices/p-guest1`).get()).data()!;
    assert.equal(stored.partyId, partyId);
    assert.equal(stored.deviceId, "p-guest1");
    assert.equal(stored.role, "guest");
    assert.equal(stored.status, "active");
    assert.ok(!("label" in stored), "guest doc must omit label");
    const firstAt = stored.registeredAt;

    // Rejoin with hostile overrides: idempotent, fields untouched.
    const second = await services.joinParty({
      partyId, deviceId: "p-guest1", channelId, role: "tv", status: "inactive", label: "Hacker",
    });
    assert.equal(second.created, false);
    const restorted = (await db.doc(`parties/${partyId}/devices/p-guest1`).get()).data()!;
    assert.equal(restorted.role, "guest");
    assert.equal(restorted.status, "active");
    assert.ok(!("label" in restorted));
    assert.ok(firstAt.isEqual(restorted.registeredAt), "rejoin must not rewrite timestamps");

    // TV deviceId collision is forbidden and leaves the TV doc alone.
    await assert.rejects(
      services.joinParty({ partyId, deviceId: "tv-host", channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN",
    );
    const tv = (await db.doc(`parties/${partyId}/devices/tv-host`).get()).data()!;
    assert.equal(tv.role, "tv");
  } finally {
    await db.recursiveDelete(db.doc(`parties/${partyId}`));
    await disposeEmulatorContext(app);
  }
});

test("joinParty enforces PIN, party, and channel gates without mutation", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const channelId = "main";
  try {
    await seedHost(db, partyId, "tv-host", channelId, { joinPin: "004201" });
    const services = createJoinPartyService({ db });

    const ok = await services.joinParty({ partyId, deviceId: "p-pined", channelId, joinPin: "004201" });
    assert.equal(ok.created, true);

    for (const bad of [
      { partyId, deviceId: "p-bad1", channelId },
      { partyId, deviceId: "p-bad2", channelId, joinPin: "999999" },
    ]) {
      await assert.rejects(
        services.joinParty(bad),
        (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN",
      );
    }
    // Malformed PIN shapes never reach the service gate.
    for (const joinPin of ["4201", "1234567", "abcdef"]) {
      await assert.rejects(
        services.joinParty({ partyId, deviceId: "p-bad4", channelId, joinPin }),
        (error: unknown) => error instanceof BackendError && error.errorCode === "INVALID_ARGUMENT",
      );
    }
    for (const deviceId of ["p-bad1", "p-bad2", "p-bad4"]) {
      assert.equal((await db.doc(`parties/${partyId}/devices/${deviceId}`).get()).exists, false);
    }

    // Every rejoin revalidates: rotating the PIN invalidates the old one.
    await db.doc(`parties/${partyId}`).update({ joinPin: "123456" });
    await assert.rejects(
      services.joinParty({ partyId, deviceId: "p-pined", channelId, joinPin: "004201" }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN",
    );
    const again = await services.joinParty({ partyId, deviceId: "p-pined", channelId, joinPin: "123456" });
    assert.equal(again.created, false);
  } finally {
    await db.recursiveDelete(db.doc(`parties/${partyId}`));
    await disposeEmulatorContext(app);
  }
});

test("joinParty rejects unknown/inactive party, channel mismatch, and bad registrations", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db } = await createEmulatorContext();
  const partyId = randomPartyId();
  const channelId = "main";
  try {
    await seedHost(db, partyId, "tv-host", channelId);
    const services = createJoinPartyService({ db });
    const missing = async (input: unknown): Promise<boolean> =>
      (await db.doc(`parties/${partyId}/devices/${(input as { deviceId: string }).deviceId}`).get()).exists;

    await assert.rejects(
      services.joinParty({ partyId: "no-such-party", deviceId: "p-x", channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN",
    );
    await assert.rejects(
      services.joinParty({ partyId, deviceId: "p-x", channelId: "other-channel" }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN",
    );
    assert.equal(await missing({ deviceId: "p-x" }), false);

    // Inactive channel doc.
    await db.doc(`parties/${partyId}/channels/${channelId}`).update({ status: "inactive" });
    await assert.rejects(
      services.joinParty({ partyId, deviceId: "p-y", channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN",
    );
    await db.doc(`parties/${partyId}/channels/${channelId}`).update({ status: "active" });

    // Inactive party.
    await db.doc(`parties/${partyId}`).update({ status: "suspended" });
    await assert.rejects(
      services.joinParty({ partyId, deviceId: "p-y", channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN",
    );
    await db.doc(`parties/${partyId}`).update({ status: "active" });

    // Invalid stored PIN fails closed: every attempt is forbidden.
    await db.doc(`parties/${partyId}`).update({ joinPin: "not-a-pin" });
    for (const input of [
      { partyId, deviceId: "p-y", channelId },
      { partyId, deviceId: "p-y", channelId, joinPin: "123456" },
    ]) {
      await assert.rejects(
        services.joinParty(input),
        (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN",
      );
    }
    await db.doc(`parties/${partyId}`).update({ joinPin: "" });

    // Inactive, mismatched, and malformed device docs are forbidden without mutation.
    await db.doc(`parties/${partyId}/devices/p-off`).set({ partyId, deviceId: "p-off", role: "guest", status: "inactive" });
    await db.doc(`parties/${partyId}/devices/p-foreign`).set({ partyId: "other-party", deviceId: "p-foreign", role: "guest", status: "active" });
    await db.doc(`parties/${partyId}/devices/p-norole`).set({ partyId, deviceId: "p-norole", status: "active" });
    for (const deviceId of ["p-off", "p-foreign", "p-norole"]) {
      await assert.rejects(
        services.joinParty({ partyId, deviceId, channelId }),
        (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN",
      );
    }
    assert.equal((await db.doc(`parties/${partyId}/devices/p-off`).get()).data()?.status, "inactive");
    assert.equal((await db.doc(`parties/${partyId}/devices/p-foreign`).get()).data()?.partyId, "other-party");
  } finally {
    await db.recursiveDelete(db.doc(`parties/${partyId}`));
    await disposeEmulatorContext(app);
  }
});

test("concurrent same-ID joins create exactly one guest doc", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db } = await createEmulatorContext();
  const partyId = randomPartyId();
  const channelId = "main";
  try {
    await seedHost(db, partyId, "tv-host", channelId);
    const services = createJoinPartyService({ db });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => services.joinParty({ partyId, deviceId: "p-race", channelId })),
    );
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.ok(results.every((r) => r.role === "guest" && r.status === "active"));
    const snap = await db.doc(`parties/${partyId}/devices/p-race`).get();
    assert.equal(snap.exists, true);
    assert.equal(snap.data()?.role, "guest");
  } finally {
    await db.recursiveDelete(db.doc(`parties/${partyId}`));
    await disposeEmulatorContext(app);
  }
});
