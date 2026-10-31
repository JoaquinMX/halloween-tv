import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Firestore, Timestamp } from "firebase-admin/firestore";
import {
  BackendError,
  CreateHostInviteResult,
  JoinHostResult,
  parseCreateHostInviteInput,
  parseJoinHostInput,
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

function inviteRef(db: Firestore, partyId: string, inviteId: string) {
  return db.doc(`parties/${partyId}/hostInvites/${inviteId}`);
}

/**
 * Host invite + redemption service.
 *
 * Only a registered TV may mint a short-lived host invite. The token is
 * returned once and only its SHA-256 hash is stored, bound to
 * party/channel/expiry. Redemption is transactional for a separate phone
 * identity with the server-assigned host role: same-device redemption
 * retries are idempotent, while other-device replay, expiry, guest PIN
 * reuse, and client-only role changes can never grant host access. Legacy
 * joinParty remains guest-only (see join_party.ts: non-guest device docs
 * are rejected and the role is always written server-side).
 */
export function createHostJoinService(options: HostJoinServiceOptions): {
  createHostInvite(value: unknown): Promise<CreateHostInviteResult>;
  joinHost(value: unknown): Promise<JoinHostResult>;
} {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  async function createHostInvite(value: unknown): Promise<CreateHostInviteResult> {
    const input = parseCreateHostInviteInput(value);
    const tv = await assertRegisteredTvDevice(db, input);
    const token = `hi-${randomBytes(24).toString("hex")}`;
    const tokenHash = inviteTokenHash(token);
    const inviteId = tokenHash.slice(0, 32);
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + HOST_INVITE_TTL_MS);
    await inviteRef(db, tv.partyId, inviteId).create({
      inviteId,
      tokenHash,
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
        throw new BackendError("FORBIDDEN", "Host invite is invalid or expired.");
      }
      const invite = inviteSnap.data()!;
      if (
        invite.tokenHash !== tokenHash ||
        invite.partyId !== input.partyId ||
        invite.channelId !== input.channelId
      ) {
        throw new BackendError("FORBIDDEN", "Host invite is invalid or expired.");
      }
      const expiresMs =
        invite.expiresAt instanceof Timestamp
          ? invite.expiresAt.toDate().getTime()
          : Date.parse(String(invite.expiresAt));
      if (!Number.isFinite(expiresMs) || expiresMs <= now().getTime()) {
        throw new BackendError("FORBIDDEN", "Host invite is invalid or expired.");
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
        throw new BackendError("FORBIDDEN", "Host invite is invalid or expired.");
      }
      if (
        !channelSnap.exists ||
        channelSnap.data()?.partyId !== input.partyId ||
        channelSnap.data()?.status !== "active" ||
        partySnap.data()?.activeChannelId !== input.channelId
      ) {
        throw new BackendError("FORBIDDEN", "Host invite is invalid or expired.");
      }
      // Other-device replay: an invite redeemed by one phone cannot admit
      // another phone, even with the same token.
      if (
        typeof invite.usedByDevice === "string" &&
        invite.usedByDevice !== input.deviceId
      ) {
        throw new BackendError("FORBIDDEN", "Host invite is invalid or expired.");
      }
      if (deviceSnap.exists) {
        const device = deviceSnap.data()!;
        if (
          device.partyId !== input.partyId ||
          device.status !== "active" ||
          (typeof device.deviceId === "string" && device.deviceId !== input.deviceId)
        ) {
          throw new BackendError("FORBIDDEN", "Host invite is invalid or expired.");
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
        throw new BackendError("FORBIDDEN", "Host invite is invalid or expired.");
      }
      transaction.set(deviceRef, {
        partyId: input.partyId,
        deviceId: input.deviceId,
        role: "host",
        status: "active",
        registeredAt: FieldValue.serverTimestamp(),
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

  return { createHostInvite, joinHost };
}

/** Test/ops helper: hash an invite token to locate its stored invite doc. */
export function hashHostInviteToken(token: string): string {
  return inviteTokenHash(token);
}
