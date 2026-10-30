import assert from "node:assert/strict";
import test from "node:test";
import { BackendError } from "../src/contracts";
import { createGuestListService } from "../src/guest_list";
import { createRuntimeServices } from "../src/runtime";
import { HAS_FIRESTORE_EMULATOR, createEmulatorContext, disposeEmulatorContext, randomPartyId } from "./support/emulators";

test("TV device lists guest codes; guests and strangers get FORBIDDEN", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const tvDevice = "tv-host";
  const channelId = "haunted_surveillance";
  try {
    await db.doc(`parties/${partyId}`).set({ ownerUid: null, status: "active", activeChannelId: channelId });
    await db.doc(`parties/${partyId}/channels/${channelId}`).set({ partyId, channelId, status: "active" });
    await db.doc(`parties/${partyId}/devices/${tvDevice}`).set({ partyId, deviceId: tvDevice, label: "TV", role: "tv", status: "active" });
    await db.doc(`parties/${partyId}/devices/g-aaa`).set({ partyId, deviceId: "g-aaa", label: "Guest 1", role: "guest", status: "active" });
    await db.doc(`parties/${partyId}/devices/g-bbb`).set({ partyId, deviceId: "g-bbb", label: "Guest 2", role: "guest", status: "active" });

    const services = createGuestListService({ db });
    const listing = await services.listPartyDevices({ partyId, deviceId: tvDevice, channelId });
    assert.equal(listing.partyId, partyId);
    assert.equal(listing.channelId, channelId);
    assert.equal(listing.tvDeviceId, tvDevice);
    assert.deepEqual(listing.devices.map((entry) => entry.deviceId), ["g-aaa", "g-bbb"]);
    assert.ok(listing.devices.every((entry) => entry.role === "guest" && entry.status === "active"));
    // The TV itself is never listed as a guest code.
    assert.ok(!listing.devices.some((entry) => entry.deviceId === tvDevice));

    await assert.rejects(services.listPartyDevices({ partyId, deviceId: "g-aaa", channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");
    await assert.rejects(services.listPartyDevices({ partyId, deviceId: "stranger", channelId }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "FORBIDDEN");
    await assert.rejects(services.listPartyDevices({ partyId, deviceId: tvDevice }),
      (error: unknown) => error instanceof BackendError && error.errorCode === "INVALID_ARGUMENT");

    // The exported runtime composition serves the same handler (preflight gate).
    const runtime = createRuntimeServices({ db, bucket });
    const runtimeListing = await runtime.listPartyDevices({ partyId, deviceId: tvDevice, channelId });
    assert.equal(runtimeListing.devices.length, 2);
  } finally {
    await db.recursiveDelete(db.doc(`parties/${partyId}`));
    await disposeEmulatorContext(app);
  }
});

test("host listing tolerates label-absent guests and surfaces joinPin only when configured", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const tvDevice = "tv-host";
  const channelId = "main";
  try {
    await db.doc(`parties/${partyId}`).set({ ownerUid: null, status: "active", activeChannelId: channelId, joinPin: "004201" });
    await db.doc(`parties/${partyId}/channels/${channelId}`).set({ partyId, channelId, status: "active" });
    await db.doc(`parties/${partyId}/devices/${tvDevice}`).set({ partyId, deviceId: tvDevice, label: "TV", role: "tv", status: "active" });
    await db.doc(`parties/${partyId}/devices/p-nolabel`).set({ partyId, deviceId: "p-nolabel", role: "guest", status: "active" });
    await db.doc(`parties/${partyId}/devices/p-emptylabel`).set({ partyId, deviceId: "p-emptylabel", label: "", role: "guest", status: "active" });
    await db.doc(`parties/${partyId}/devices/p-spacelabel`).set({ partyId, deviceId: "p-spacelabel", label: "   ", role: "guest", status: "active" });
    await db.doc(`parties/${partyId}/devices/p-named`).set({ partyId, deviceId: "p-named", label: "Named", role: "guest", status: "active" });

    const runtime = createRuntimeServices({ db, bucket });
    const listing = await runtime.listPartyDevices({ partyId, deviceId: tvDevice, channelId });
    assert.equal(listing.devices.length, 4);
    assert.equal(listing.joinPin, "004201");
    const byId = new Map(listing.devices.map((entry) => [entry.deviceId, entry]));
    assert.ok(!("label" in byId.get("p-nolabel")!));
    assert.ok(!("label" in byId.get("p-emptylabel")!));
    assert.ok(!("label" in byId.get("p-spacelabel")!), "whitespace-only labels normalize to absent");
    assert.equal(byId.get("p-named")!.label, "Named");
    assert.ok(listing.devices.every((entry) => entry.role === "guest" && entry.status === "active"));
    assert.ok(!listing.devices.some((entry) => entry.deviceId === tvDevice));

    await db.doc(`parties/${partyId}`).update({ joinPin: "" });
    const unpinned = await runtime.listPartyDevices({ partyId, deviceId: tvDevice, channelId });
    assert.ok(!("joinPin" in unpinned));
  } finally {
    await db.recursiveDelete(db.doc(`parties/${partyId}`));
    await disposeEmulatorContext(app);
  }
});

test("host listing fails closed on a malformed stored PIN", { skip: !HAS_FIRESTORE_EMULATOR }, async () => {
  const { app, db } = await createEmulatorContext();
  const partyId = randomPartyId();
  const tvDevice = "tv-host";
  const channelId = "main";
  try {
    await db.doc(`parties/${partyId}`).set({ ownerUid: null, status: "active", activeChannelId: channelId });
    await db.doc(`parties/${partyId}/channels/${channelId}`).set({ partyId, channelId, status: "active" });
    await db.doc(`parties/${partyId}/devices/${tvDevice}`).set({ partyId, deviceId: tvDevice, label: "TV", role: "tv", status: "active" });
    const services = createGuestListService({ db });

    // A missing PIN field means "no PIN required" and omits joinPin.
    const unpinned = await services.listPartyDevices({ partyId, deviceId: tvDevice, channelId });
    assert.ok(!("joinPin" in unpinned));

    // Present-but-invalid stored PINs (console-written number/boolean/null/
    // malformed strings) surface a callable INTERNAL error: the TV panel
    // shows an error state instead of a PIN-free session.
    for (const badPin of [420100, true, null, "not-a-pin", "12 456"] as const) {
      await db.doc(`parties/${partyId}`).update({ joinPin: badPin });
      const error = await services.listPartyDevices({ partyId, deviceId: tvDevice, channelId }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(error instanceof BackendError, `stored PIN ${String(badPin)} must fail closed`);
      assert.equal(error.errorCode, "INTERNAL");
      assert.match(error.message, /misconfigured/);
    }

    // Empty string stays unpinned.
    await db.doc(`parties/${partyId}`).update({ joinPin: "" });
    const reopened = await services.listPartyDevices({ partyId, deviceId: tvDevice, channelId });
    assert.ok(!("joinPin" in reopened));
  } finally {
    await db.recursiveDelete(db.doc(`parties/${partyId}`));
    await disposeEmulatorContext(app);
  }
});
