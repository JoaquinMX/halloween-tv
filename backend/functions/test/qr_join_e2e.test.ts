import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { HAS_FIRESTORE_EMULATOR, PROJECT_ID, clearParty, createEmulatorContext, disposeEmulatorContext, randomPartyId } from "./support/emulators";

/**
 * QR-join end-to-end through the REAL exported Functions emulator endpoints
 * with NO auth (no Firebase Auth, no ID tokens, no owner headers).
 *
 * This test REQUIRES the Functions emulator inside `npm run test:emulator`.
 * When the emulator project is configured but the callable endpoint is
 * unreachable or unexported, the test fails loudly: it never skips and never
 * substitutes the service layer, a local stub, or direct Firestore writes for
 * the join/list/manifest callables under test. Direct Admin SDK access is
 * used ONLY for fixed seeding (party/channel/TV + PIN + manifest fixture)
 * and for inspecting persisted guest docs.
 *
 * Wire contract under test (fixed for cycle-8):
 * - joinParty {partyId, deviceId, channelId, joinPin?} ->
 *   {partyId, deviceId, channelId, role: "guest", status: "active", created}.
 *   The PIN is never echoed. Failures surface as callable errors with
 *   details.errorCode: FORBIDDEN / UNAUTHENTICATED / INVALID_ARGUMENT.
 * - listPartyDevices (TV-only) gains optional joinPin; entries carry
 *   {deviceId, label?, role, status} with label absent/empty for
 *   self-registered guests.
 */

const FUNCTIONS_BASE = `http://${process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5001"}/${PROJECT_ID}/us-central1`;

function phoneDeviceId(): string {
  return `p-${randomBytes(16).toString("hex")}`;
}

async function postCallable(path: string, data: Record<string, unknown>): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${FUNCTIONS_BASE}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    assert.fail(
      `Functions emulator endpoint ${path} is unreachable at ${FUNCTIONS_BASE} ` +
      `(${error instanceof Error ? error.message : String(error)}). ` +
      `Run under npm run test:emulator with the functions emulator enabled; ` +
      `this test never substitutes another transport.`,
    );
  }
  return response;
}

async function callFunction(path: string, data: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await postCallable(path, data);
  const text = await response.text();
  let body: any = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    assert.fail(
      `Callable ${path} is not served by the Functions emulator (HTTP ${response.status} non-JSON: ${text.slice(0, 200)}). ` +
      `Run under npm run test:emulator with the functions emulator serving the exported triggers; ` +
      `this test never skips and never substitutes another transport.`,
    );
  }
  assert.equal(response.status, 200, `Callable ${path} must be exported and reachable (HTTP ${response.status}: ${text.slice(0, 300)}).`);
  assert.ok(body && typeof body.result === "object" && body.result !== null, `Callable ${path} returned no result envelope.`);
  return body.result as Record<string, any>;
}

async function expectCallableError(
  path: string,
  data: Record<string, unknown>,
  expectedHttp: number,
  expectedCode: string,
): Promise<void> {
  const response = await postCallable(path, data);
  assert.equal(response.status, expectedHttp, `Callable ${path} must fail with HTTP ${expectedHttp} (got ${response.status}).`);
  const body = (await response.json()) as { error?: { message?: string; status?: string; details?: { errorCode?: string } } };
  assert.equal(body.error?.details?.errorCode, expectedCode,
    `Callable ${path} must surface details.errorCode ${expectedCode} (got ${JSON.stringify(body)}).`);
}

const JOIN_PIN = "004201";
const CHANNEL = "haunted_surveillance";

test("qr join end-to-end: PIN-gated self-registration, TV listing, legacy manifest read", {
  skip: !HAS_FIRESTORE_EMULATOR ? "requires the Firestore emulator" : false,
}, async () => {
  const { app, db, bucket } = await createEmulatorContext();
  const partyId = randomPartyId();
  const tvDevice = "tv-host";
  try {
    await db.doc(`parties/${partyId}`).set({ ownerUid: null, status: "active", activeChannelId: CHANNEL, retentionNote: "keep" });
    await db.doc(`parties/${partyId}/channels/${CHANNEL}`).set({ partyId, channelId: CHANNEL, status: "active" });
    await db.doc(`parties/${partyId}/devices/${tvDevice}`).set({ partyId, deviceId: tvDevice, label: "TV", role: "tv", status: "active" });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const cameras = ["CAM-01", "CAM-02", "CAM-03", "CAM-04"] as const;
    // Server-minted legacy seed authorization for the seeded wall manifest:
    // the manifest cites job "seed-job" whose authorization lives in the
    // seed catalog (written here through the server-side seed path, never
    // fabricated mobile consent). The delivery gate resolves the implied
    // legacy binding from this entry.
    await db.doc(`parties/${partyId}/seedVideos/seed-legacy-wall`).set({
      seedId: "seed-legacy-wall",
      partyId,
      channelId: CHANNEL,
      jobId: "seed-job",
      status: "ready",
      operatorApproved: true,
      expiresAt,
    });
    await db.doc(`parties/${partyId}/manifests/current_${CHANNEL}`).set({
      partyId,
      channelId: CHANNEL,
      version: 1,
      schemaVersion: 1,
      jobId: "seed-job",
      cameraClips: cameras.map((cameraId, index) => ({
        cameraId,
        objectPath: `parties/${partyId}/channels/${CHANNEL}/delivery/1/${cameraId}.mp4`,
        sha256: `${index}${"a".repeat(63)}`,
        sizeBytes: 1024 + index,
        durationMs: 2000,
        expiresAt,
      })),
      createdAt: new Date().toISOString(),
      expiresAt,
    });

    const unpinned = await callFunction("listPartyDevices", { partyId, deviceId: tvDevice, channelId: CHANNEL });
    assert.ok(!("joinPin" in unpinned), "listPartyDevices without a configured PIN must omit joinPin, not send null.");

    await db.doc(`parties/${partyId}`).set({ joinPin: JOIN_PIN }, { merge: true });

    const guestA = phoneDeviceId();
    const guestB = phoneDeviceId();
    assert.match(guestA, /^p-[0-9a-f]{32}$/);
    assert.notEqual(guestA, guestB);

    const joinedA = await callFunction("joinParty", { partyId, deviceId: guestA, channelId: CHANNEL, joinPin: JOIN_PIN });
    assert.deepEqual(
      { partyId: joinedA.partyId, deviceId: joinedA.deviceId, channelId: joinedA.channelId, role: joinedA.role, status: joinedA.status, created: joinedA.created },
      { partyId, deviceId: guestA, channelId: CHANNEL, role: "guest", status: "active", created: true },
    );
    assert.ok(!("joinPin" in joinedA) && !("join_pin" in joinedA), "joinParty must never echo the PIN.");

    const joinedB = await callFunction("joinParty", { partyId, deviceId: guestB, channelId: CHANNEL, joinPin: JOIN_PIN });
    assert.equal(joinedB.created, true);
    assert.equal(joinedB.role, "guest");

    const beforeRejoin = (await db.doc(`parties/${partyId}/devices/${guestA}`).get()).data()!;
    const rejoinedA = await callFunction("joinParty", { partyId, deviceId: guestA, channelId: CHANNEL, joinPin: JOIN_PIN });
    assert.equal(rejoinedA.created, false, "rejoining the same phone id must report created:false.");
    assert.deepEqual(
      { partyId: rejoinedA.partyId, deviceId: rejoinedA.deviceId, channelId: rejoinedA.channelId, role: rejoinedA.role, status: rejoinedA.status },
      { partyId, deviceId: guestA, channelId: CHANNEL, role: "guest", status: "active" },
    );
    const afterRejoin = (await db.doc(`parties/${partyId}/devices/${guestA}`).get()).data()!;
    assert.deepEqual(afterRejoin, beforeRejoin, "rejoin must not rewrite the persisted guest doc.");

    const rejoinedExtra = await callFunction("joinParty",
      { partyId, deviceId: guestA, channelId: CHANNEL, joinPin: JOIN_PIN, qrExtra: "ignored", url: "https://example.invalid" });
    assert.equal(rejoinedExtra.created, false, "extra scanned/pasted keys must be ignored, not rejected.");

    for (const guest of [guestA, guestB]) {
      const persisted = (await db.doc(`parties/${partyId}/devices/${guest}`).get()).data()!;
      assert.equal(persisted.partyId, partyId);
      assert.equal(persisted.deviceId, guest);
      assert.equal(persisted.role, "guest");
      assert.equal(persisted.status, "active");
      assert.ok(!("label" in persisted) || persisted.label === "" || persisted.label === undefined,
        "self-registered guests must persist with absent/empty label (no names collected).");
      assert.ok(!("joinPin" in persisted), "the PIN must never be stored on guest device docs.");
    }

    const listing = await callFunction("listPartyDevices", { partyId, deviceId: tvDevice, channelId: CHANNEL });
    assert.equal(listing.partyId, partyId);
    assert.equal(listing.channelId, CHANNEL);
    assert.equal(listing.tvDeviceId, tvDevice);
    assert.equal(listing.joinPin, JOIN_PIN, "listPartyDevices must surface the configured PIN to the TV host.");
    assert.ok(Array.isArray(listing.devices));
    assert.deepEqual(listing.devices.map((entry: { deviceId: string }) => entry.deviceId).sort(), [guestA, guestB].sort());
    assert.ok(!listing.devices.some((entry: { deviceId: string }) => entry.deviceId === tvDevice), "the TV must be excluded from its own listing.");
    for (const entry of listing.devices as Array<{ deviceId: string; label?: unknown; role: string; status: string }>) {
      assert.equal(entry.role, "guest");
      assert.equal(entry.status, "active");
      assert.ok(entry.label === undefined || entry.label === "",
        "self-registered entries must carry absent/empty label, never the device id as label+value.");
    }

    await expectCallableError("joinParty", { partyId, deviceId: phoneDeviceId(), channelId: CHANNEL, joinPin: "999999" }, 403, "FORBIDDEN");
    await expectCallableError("joinParty", { partyId, deviceId: tvDevice, channelId: CHANNEL, joinPin: JOIN_PIN }, 403, "FORBIDDEN");
    await expectCallableError("joinParty", { partyId, deviceId: phoneDeviceId(), channelId: CHANNEL, joinPin: "42" }, 400, "INVALID_ARGUMENT");
    await expectCallableError("joinParty", { partyId, deviceId: phoneDeviceId(), channelId: CHANNEL }, 403, "FORBIDDEN");
    await expectCallableError("joinParty", { channelId: CHANNEL, deviceId: phoneDeviceId(), joinPin: JOIN_PIN }, 401, "UNAUTHENTICATED");
    await expectCallableError("joinParty", { partyId, channelId: CHANNEL, joinPin: JOIN_PIN }, 401, "UNAUTHENTICATED");
    await expectCallableError("joinParty", { partyId, deviceId: phoneDeviceId(), channelId: "wrong_channel", joinPin: JOIN_PIN }, 403, "FORBIDDEN");

    await expectCallableError("listPartyDevices", { partyId, deviceId: guestA, channelId: CHANNEL }, 403, "FORBIDDEN");

    await db.doc(`parties/${partyId}/devices/g-legacy`).set({ partyId, deviceId: "g-legacy", label: "Guest 1", role: "guest", status: "active" });
    const manifest = await callFunction("getCurrentManifest", { partyId, deviceId: "g-legacy", channelId: CHANNEL });
    assert.equal(manifest.version, 1);
    assert.equal(manifest.channelId, CHANNEL);
    assert.equal(manifest.cameraClips.length, 4, "a pre-seeded legacy guest still reads the seeded valid manifest.");
  } finally {
    await clearParty(db, bucket, partyId);
    await disposeEmulatorContext(app);
  }
});
