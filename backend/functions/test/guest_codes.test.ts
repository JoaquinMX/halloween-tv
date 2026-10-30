import assert from "node:assert/strict";
import test from "node:test";
import { buildGuestSpecs, generateGuestCode, renderHostSheet, validateGuestCode } from "../tools/guest_codes";

test("generated guest codes are unguessable, unique, and identifier-safe", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 25; index += 1) {
    const code = generateGuestCode();
    assert.match(code, /^g-[0-9a-f]{16}$/);
    assert.ok(!seen.has(code));
    seen.add(code);
    assert.equal(validateGuestCode(code, "cloud"), code);
  }
});

test("explicit cloud codes refuse guessable values; emulator allows short codes", () => {
  for (const guessable of ["guest", "Guest1", "guest-2", "test", "tv-pilot", "abc"]) {
    assert.throws(() => validateGuestCode(guessable, "cloud"));
  }
  assert.equal(validateGuestCode("g7", "emulator"), "g7");
  assert.throws(() => validateGuestCode("has space!", "emulator"));
  assert.throws(() => validateGuestCode("", "emulator"));
});

test("buildGuestSpecs generates labeled batches and validates explicit codes", () => {
  const generated = buildGuestSpecs({ target: "cloud", count: 3 });
  assert.equal(generated.length, 3);
  assert.deepEqual(generated.map((spec) => spec.label), ["Guest 1", "Guest 2", "Guest 3"]);
  const explicit = buildGuestSpecs({ target: "cloud", codes: ["family-room-ipad", "kids-table-01"], labelPrefix: "Remote" });
  assert.deepEqual(explicit, [
    { deviceId: "family-room-ipad", label: "Remote 1" },
    { deviceId: "kids-table-01", label: "Remote 2" },
  ]);
  assert.throws(() => buildGuestSpecs({ target: "cloud", count: 0 }));
  assert.throws(() => buildGuestSpecs({ target: "cloud", count: 51 }));
  assert.throws(() => buildGuestSpecs({ target: "cloud", codes: ["ok-code-123", "ok-code-123"] }));
  assert.throws(() => buildGuestSpecs({ target: "cloud", codes: ["guest1"] }));
});

test("host sheet lists the TV code and every guest code with its label", () => {
  const sheet = renderHostSheet({
    party: "party-1",
    channel: "haunted_surveillance",
    tvDevice: "tv-abc123",
    guests: [{ deviceId: "g-001", label: "Guest 1" }],
    applied: false,
  });
  assert.ok(sheet.includes("PREVIEW"));
  assert.ok(sheet.includes("party-1"));
  assert.ok(sheet.includes("tv-abc123"));
  assert.ok(sheet.includes("Guest 1: g-001"));
});
