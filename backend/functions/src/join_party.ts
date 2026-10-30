import { FieldValue, Firestore } from "firebase-admin/firestore";
import { BackendError, JOIN_PIN_RE, parseJoinPartyInput } from "./contracts";

/** Single rejection message shared by every join gate (see above). */
const JOIN_REJECTED_MESSAGE = "Join request was rejected.";

export interface JoinPartyResult {
  partyId: string;
  deviceId: string;
  channelId: string;
  role: "guest";
  status: "active";
  created: boolean;
}

export interface JoinPartyServiceOptions {
  db: Firestore;
}

/**
 * Anonymous phone registration. Each call revalidates party, channel, and
 * PIN inside a single Firestore transaction before creating (or reusing)
 * the guest device doc. The PIN is never echoed in the response.
 *
 * Every rejection below shares ONE identical message: distinct texts would
 * let callers probe which gate (party/channel/PIN/device) failed. The
 * specific reason is only server-logged. All rejections keep errorCode
 * FORBIDDEN so the callable `details.errorCode` mapping is unchanged.
 */
export function createJoinPartyService(options: JoinPartyServiceOptions): {
  joinParty(value: unknown): Promise<JoinPartyResult>;
} {
  const { db } = options;
  return {
    async joinParty(value: unknown): Promise<JoinPartyResult> {
      const input = parseJoinPartyInput(value);
      return db.runTransaction(async (transaction) => {
        const partyRef = db.doc(`parties/${input.partyId}`);
        const channelRef = partyRef.collection("channels").doc(input.channelId);
        const deviceRef = partyRef.collection("devices").doc(input.deviceId);
        const [partySnap, channelSnap, deviceSnap] = await Promise.all([
          transaction.get(partyRef),
          transaction.get(channelRef),
          transaction.get(deviceRef),
        ]);
        if (!partySnap.exists) {
          console.warn(`joinParty rejected: unknown party ${input.partyId}`);
          throw new BackendError("FORBIDDEN", JOIN_REJECTED_MESSAGE);
        }
        const party = partySnap.data()!;
        if (party.status !== "active") {
          console.warn(`joinParty rejected: inactive party ${input.partyId}`);
          throw new BackendError("FORBIDDEN", JOIN_REJECTED_MESSAGE);
        }
        if (party.activeChannelId !== input.channelId) {
          console.warn(
            `joinParty rejected: channel ${input.channelId} is not active for party ${input.partyId}`,
          );
          throw new BackendError("FORBIDDEN", JOIN_REJECTED_MESSAGE);
        }
        if (!channelSnap.exists) {
          console.warn(
            `joinParty rejected: channel ${input.channelId} is not registered for party ${input.partyId}`,
          );
          throw new BackendError("FORBIDDEN", JOIN_REJECTED_MESSAGE);
        }
        const channel = channelSnap.data()!;
        if (channel.partyId !== input.partyId || channel.status !== "active") {
          console.warn(
            `joinParty rejected: channel doc ${input.channelId} is inactive or mismatched for party ${input.partyId}`,
          );
          throw new BackendError("FORBIDDEN", JOIN_REJECTED_MESSAGE);
        }
        // Fail closed: ANY present-but-invalid stored PIN (number/boolean/
        // malformed string written via console) counts as configured and
        // rejects every attempt. Only a missing field or an empty string
        // means "no PIN configured".
        const storedPin: unknown = party.joinPin;
        const pinUnset = storedPin === undefined || storedPin === "";
        if (!pinUnset) {
          if (typeof storedPin !== "string" || !JOIN_PIN_RE.test(storedPin)) {
            console.warn(
              `joinParty rejected: party ${input.partyId} has a misconfigured joinPin; re-provision it with seed_join`,
            );
            throw new BackendError("FORBIDDEN", JOIN_REJECTED_MESSAGE);
          }
          if (input.joinPin !== storedPin) {
            console.warn(
              `joinParty rejected: wrong or missing join PIN for party ${input.partyId}`,
            );
            throw new BackendError("FORBIDDEN", JOIN_REJECTED_MESSAGE);
          }
        }
        if (deviceSnap.exists) {
          const device = deviceSnap.data()!;
          if (
            device.partyId !== input.partyId ||
            device.role !== "guest" ||
            device.status !== "active" ||
            (typeof device.deviceId === "string" && device.deviceId !== input.deviceId)
          ) {
            console.warn(
              `joinParty rejected: device ${input.deviceId} is not a valid guest registration for party ${input.partyId}`,
            );
            throw new BackendError("FORBIDDEN", JOIN_REJECTED_MESSAGE);
          }
          return {
            partyId: input.partyId,
            deviceId: input.deviceId,
            channelId: input.channelId,
            role: "guest" as const,
            status: "active" as const,
            created: false,
          };
        }
        transaction.set(deviceRef, {
          partyId: input.partyId,
          deviceId: input.deviceId,
          role: "guest",
          status: "active",
          registeredAt: FieldValue.serverTimestamp(),
        });
        return {
          partyId: input.partyId,
          deviceId: input.deviceId,
          channelId: input.channelId,
          role: "guest" as const,
          status: "active" as const,
          created: true,
        };
      });
    },
  };
}
