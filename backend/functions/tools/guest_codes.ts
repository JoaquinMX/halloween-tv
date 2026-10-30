/**
 * Pure guest-code helpers (no Firebase I/O): generation, validation, and the
 * host code sheet printed for verbal dictation. Tested without an emulator.
 */
import { randomBytes } from "node:crypto";

export const GUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GENERATED_PREFIX = "g-";
const GENERATED_HEX_CHARS = 16;

/** Guessable stems refused for explicit cloud guest codes. */
const BLOCKED_EXPLICIT_CODES = new Set([
  "guest", "guest1", "guest2", "test", "demo", "pilot", "tv-pilot", "party", "halloween",
]);

export interface GuestCodeSpec {
  deviceId: string;
  label: string;
}

/** Generates one unguessable guest device code (`g-` + 16 hex chars). */
export function generateGuestCode(): string {
  return `${GENERATED_PREFIX}${randomBytes(GENERATED_HEX_CHARS / 2).toString("hex")}`;
}

function fail(message: string): never {
  throw new Error(message);
}

/** Validates an explicit guest code. Cloud targets require length >= 8. */
export function validateGuestCode(code: string, target: "emulator" | "cloud"): string {
  const trimmed = code.trim();
  if (!GUEST_ID_RE.test(trimmed)) {
    fail(`Guest code ${JSON.stringify(code)} is invalid: single path segment, letter/digit start.`);
  }
  if (target === "cloud") {
    const lowered = trimmed.toLowerCase();
    if (trimmed.length < 8 || BLOCKED_EXPLICIT_CODES.has(lowered) || /^guest-?\d*$/.test(lowered)) {
      fail(`Guest code ${JSON.stringify(code)} is too guessable for a cloud party; omit --codes to generate unguessable codes.`);
    }
  }
  return trimmed;
}

/** Builds the guest list from a count (generated codes) or explicit codes. */
export function buildGuestSpecs(options: {
  target: "emulator" | "cloud";
  count?: number;
  codes?: string[];
  labelPrefix?: string;
}): GuestCodeSpec[] {
  const labelPrefix = (options.labelPrefix ?? "Guest").trim() || "Guest";
  if (options.codes !== undefined) {
    if (options.codes.length === 0) fail("Explicit --codes is empty; provide at least one code or omit it to generate codes.");
    const seen = new Set<string>();
    return options.codes.map((code, index) => {
      const deviceId = validateGuestCode(code, options.target);
      if (seen.has(deviceId)) fail(`Duplicate guest code ${JSON.stringify(deviceId)}.`);
      seen.add(deviceId);
      return { deviceId, label: `${labelPrefix} ${index + 1}` };
    });
  }
  const count = options.count ?? 6;
  if (!Number.isSafeInteger(count) || count < 1 || count > 50) {
    fail(`Guest --count must be an integer from 1 to 50, got ${String(options.count)}.`);
  }
  const seen = new Set<string>();
  const specs: GuestCodeSpec[] = [];
  for (let index = 0; index < count; index += 1) {
    let deviceId = generateGuestCode();
    while (seen.has(deviceId)) deviceId = generateGuestCode();
    seen.add(deviceId);
    specs.push({ deviceId, label: `${labelPrefix} ${index + 1}` });
  }
  return specs;
}

/** Renders the host code sheet: TV code plus every guest code with its label. */
export function renderHostSheet(options: {
  party: string;
  channel: string;
  tvDevice: string;
  guests: GuestCodeSpec[];
  applied: boolean;
}): string {
  const lines = [
    `Halloween TV host code sheet (${options.applied ? "APPLIED" : "PREVIEW — no writes"})`,
    `party:   ${options.party}`,
    `channel: ${options.channel}`,
    `TV code (large text on the TV panel): ${options.tvDevice}`,
    "Guest codes (host dictates verbally; QR scan comes later):",
    ...options.guests.map((guest) => `  ${guest.label}: ${guest.deviceId}`),
  ];
  return lines.join("\n");
}
