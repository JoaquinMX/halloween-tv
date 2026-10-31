import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { FieldValue, Firestore, Timestamp } from "firebase-admin/firestore";
import {
  BackendError,
  CreateHostInviteResult,
  HOST_MAX_DEVICES,
  JoinHostResult,
  RevokeHostDeviceResult,
  parseCreateHostInviteInput,
  parseJoinHostInput,
  parseRevokeHostDeviceInput,
} from "./contracts";
import { HOST_INVITE_TTL_MS } from "./config";
import { assertRegisteredTvDevice } from "./auth";

export interface HostJoinServiceOptions {
  db: Firestore;
  now?: () => Date;
}

function inviteTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function pairingCodeHash(salt: string, code: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

/** Same generic message for every redemption failure: no oracle. */
const INVITE_DENIED_MESSAGE = "Host invite is invalid or expired.";

function inviteRef(db: Firestore, partyId: string, inviteId: string) {
  return db.doc(`parties/${partyId}/hostInvites/${inviteId}`);
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Host invite + redemption service.
 *
 * Only a registered TV may mint a short-lived host invite. The token is
 * returned once and only its SHA-256 hash is stored, bound to
 * party/channel/expiry. A server-minted 6-digit pairing code is returned
 * alongside the token (displayed next to the HOST QR on the TV) and only a
 * salted hash is stored with the same TTL. Redemption requires BOTH halves
 * and is transactional for a separate phone identity with the
 * server-assigned host role: same-device redemption retries are idempotent,
 * while other-device replay, expiry, guest PIN reuse, wrong/missing pairing
 * codes, over-capacity redemption, and client-only role changes can never
 * grant host access. Legacy joinParty remains guest-only (see join_party.ts:
 * non-guest device docs are rejected and the role is always written
 * server-side).
 *
 * Minting a new invite invalidates older pending invites for the same
 * party/channel (superseded). Invite docs carry `expiresAt` for the
 * Firestore TTL policy plus the retention-sweep expiry pass.
 */
export function createHostJoinService(options: HostJoinServiceOptions): {
  createHostInvite(value: unknown): Promise<CreateHostInviteResult>;
  joinHost(value: unknown): Promise<JoinHostResult>;
  revokeHostDevice(value: unknown): Promise<RevokeHostDeviceResult>;
} {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  async function createHostInvite(value: unknown): Promise<CreateHostInviteResult> {
    const input = parseCreateHostInviteInput(value);
    const tv = await assertRegisteredTvDevice(db, input);
    const token = `hi-${randomBytes(24).toString("hex")}`;
    const tokenHash = inviteTokenHash(token);
    const inviteId = tokenHash.slice(0, 32);
    const pairingCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const pairingSalt = randomBytes(16).toString("hex");
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + HOST_INVITE_TTL_MS);
    // Minting invalidates older pending invites for the same party/channel
    // so only the newest code on the TV screen can redeem.
    try {
      const pending = await db
        .collection(`parties/${tv.partyId}/hostInvites`)
        .where("channelId", "==", tv.channelId)
        .where("status", "==", "pending")
        .get();
      await Promise.all(
        pending.docs
          .filter((doc) => doc.id !== inviteId)
          .map((doc) => doc.ref.update({ status: "superseded", updatedAt: FieldValue.serverTimestamp() }).catch(() => undefined)),
      );
    } catch {
      // Best-effort: the new invite is still bound to its own expiry.
    }
    await inviteRef(db, tv.partyId, inviteId).create({
      inviteId,
      tokenHash,
      pairingCodeHash: pairingCodeHash(pairingSalt, pairingCode),
      pairingSalt,
      partyId: tv.partyId,
      channelId: tv.channelId,
      status: "pending",
      createdByDevice: tv.deviceId,
      usedByDevice: null,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromDate(expiresAt),
    });
    return {
      partyId: tv.partyId,
      channelId: tv.channelId,
      inviteToken: token,
      pairingCode,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async function joinHost(value: unknown): Promise<JoinHostResult> {
    const input = parseJoinHostInput(value);
    const tokenHash = inviteTokenHash(input.inviteToken);
    const inviteId = tokenHash.slice(0, 32);
    return db.runTransaction(async (transaction) => {
      const inviteSnap = await transaction.get(inviteRef(db, input.partyId, inviteId));
      if (!inviteSnap.exists) {
        throw new BackendError("FORBIDDEN", INVITE_DENIED_MESSAGE);
      }
      const invite = inviteSnap.data()!;
      if (
        invite.tokenHash !== tokenHash ||
        invite.partyId !== input.partyId ||
        invite.channelId !== input.channelId
      ) {
        throw new BackendError("FORBIDDEN", INVITE_DENIED_MESSAGE);
      }
      // Same-device redemption retries stay idempotent after the invite flips
      // to redeemed; any other non-pending state (superseded, expired) denies.
      if (invite.status !== "pending" && !(invite.status === "redeemed" && invite.usedByDevice === input.deviceId)) {
        throw new BackendError("FORBIDDEN", INVITE_DENIED_MESSAGE);
      }
      const expiresMs =
        invite.expiresAt instanceof Timestamp
          ? invite.expiresAt.toDate().getTime()
          : Date.parse(String(invite.expiresAt));
      if (!Number.isFinite(expiresMs) || expiresMs <= now().getTime()) {
        throw new BackendError("FORBIDDEN", INVITE_DENIED_MESSAGE);
      }
      // Pairing-code check: wrong or mismatched codes deny generically, with
      // the same error as an unknown invite (no oracle). The parser already
      // rejects malformed codes with the same code.
      if (
        typeof invite.pairingSalt !== "string" ||
        typeof invite.pairingCodeHash !== "string" ||
        !safeEqualHex(pairingCodeHash(invite.pairingSalt, input.pairingCode), invite.pairingCodeHash)
      ) {
        throw new BackendError("FORBIDDEN", INVITE_DENIED_MESSAGE);
      }
      // Cross-party / wrong-channel tokens never redeem: the invite doc lives
      // under the party path and binds the channel explicitly.
      const partyRef = db.doc(`parties/${input.partyId}`);
      const channelRef = partyRef.collection("channels").doc(input.channelId);
      const deviceRef = partyRef.collection("devices").doc(input.deviceId);
      const [partySnap, channelSnap, deviceSnap] = await Promise.all([
        transaction.get(partyRef),
        transaction.get(channelRef),
        transaction.get(deviceRef),
      ]);
      if (!partySnap.exists || partySnap.data()?.status !== "active") {
        throw new BackendError("FORBIDDEN", INVITE_DENIED_MESSAGE);
      }
      if (
        !channelSnap.exists ||
        channelSnap.data()?.partyId !== input.partyId ||
        channelSnap.data()?.status !== "active" ||
        partySnap.data()?.activeChannelId !== input.channelId
      ) {
        throw new BackendError("FORBIDDEN", INVITE_DENIED_MESSAGE);
      }
      // Other-device replay: an invite redeemed by one phone cannot admit
      // another phone, even with the same token.
      if (
        typeof invite.usedByDevice === "string" &&
        invite.usedByDevice !== input.deviceId
      ) {
        throw new BackendError("FORBIDDEN", INVITE_DENIED_MESSAGE);
      }
      if (deviceSnap.exists) {
        const device = deviceSnap.data()!;
        if (
          device.partyId !== input.partyId ||
          device.status !== "active" ||
          (typeof device.deviceId === "string" && device.deviceId !== input.deviceId)
        ) {
          throw new BackendError("FORBIDDEN", INVITE_DENIED_MESSAGE);
        }
        // A guest-PIN registration (role guest) or any non-host doc can never
        // be upgraded by re-presenting the invite for a different device, and
        // a client-supplied role string is ignored: the role below is always
        // written server-side.
        if (device.role === "host") {
          if (invite.status !== "redeemed" || invite.usedByDevice !== input.deviceId) {
            transaction.update(inviteRef(db, input.partyId, inviteId), {
              status: "redeemed",
              usedByDevice: input.deviceId,
              redeemedAt: FieldValue.serverTimestamp(),
            });
          }
          return {
            partyId: input.partyId,
            deviceId: input.deviceId,
            channelId: input.channelId,
            role: "host" as const,
            status: "active" as const,
            created: false,
          };
        }
        throw new BackendError("FORBIDDEN", INVITE_DENIED_MESSAGE);
      }
      // Capacity: at most HOST_MAX_DEVICES active host devices per party.
      // Redemption beyond that is denied until a host is revoked. The denial
      // reuses the generic invite message so capacity cannot be probed.
      const activeHosts = await transaction.get(
        partyRef.collection("devices").where("role", "==", "host").where("status", "==", "active").limit(HOST_MAX_DEVICES + 1),
      );
      if (activeHosts.size >= HOST_MAX_DEVICES) {
        throw new BackendError("FORBIDDEN", INVITE_DENIED_MESSAGE);
      }
      transaction.set(deviceRef, {
        partyId: input.partyId,
        deviceId: input.deviceId,
        role: "host",
        status: "active",
        registeredAt: FieldValue.serverTimestamp(),
        redeemedFromInviteId: inviteId,
        redeemedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(inviteRef(db, input.partyId, inviteId), {
        status: "redeemed",
        usedByDevice: input.deviceId,
        redeemedAt: FieldValue.serverTimestamp(),
      });
      return {
        partyId: input.partyId,
        deviceId: input.deviceId,
        channelId: input.channelId,
        role: "host" as const,
        status: "active" as const,
        created: true,
      };
    });
  }

  /**
   * TV-only host revocation. Replays the TV-device auth used by
   * createHostInvite, then demotes the target host device doc and writes an
   * audit record. A revoked device fails the registered-host gate on its
   * next admin operation.
   */
  async function revokeHostDevice(value: unknown): Promise<RevokeHostDeviceResult> {
    const input = parseRevokeHostDeviceInput(value);
    const tv = await assertRegisteredTvDevice(db, input);
    if (input.targetDeviceId === tv.deviceId) {
      throw new BackendError("INVALID_ARGUMENT", "The TV device cannot revoke itself.");
    }
    const partyRef = db.doc(`parties/${tv.partyId}`);
    const targetRef = partyRef.collection("devices").doc(input.targetDeviceId);
    await db.runTransaction(async (transaction) => {
      const targetSnap = await transaction.get(targetRef);
      if (!targetSnap.exists) {
        throw new BackendError("NOT_FOUND", "Host device does not exist.");
      }
      const target = targetSnap.data()!;
      if (target.partyId !== tv.partyId || target.role !== "host") {
        throw new BackendError("FORBIDDEN", "Only an active host device for this party can be revoked.");
      }
      if (target.status !== "active") {
        throw new BackendError("FORBIDDEN", "Only an active host device for this party can be revoked.");
      }
      transaction.update(targetRef, {
        status: "revoked",
        revokedAt: FieldValue.serverTimestamp(),
        revokedByDevice: tv.deviceId,
        updatedAt: FieldValue.serverTimestamp(),
      });
      const auditRef = partyRef.collection("hostAudit").doc();
      transaction.create(auditRef, {
        action: "revoke",
        partyId: tv.partyId,
        channelId: tv.channelId,
        targetDeviceId: input.targetDeviceId,
        byDeviceId: tv.deviceId,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    return { partyId: tv.partyId, targetDeviceId: input.targetDeviceId, status: "revoked" };
  }

  return { createHostInvite, joinHost, revokeHostDevice };
}

/** Test/ops helper: hash an invite token to locate its stored invite doc. */
export function hashHostInviteToken(token: string): string {
  return inviteTokenHash(token);
}
