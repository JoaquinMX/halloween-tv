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
