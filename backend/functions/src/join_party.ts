import { FieldValue, Firestore } from "firebase-admin/firestore";
import { BackendError, JOIN_PIN_RE, parseJoinPartyInput } from "./contracts";

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
          throw new BackendError("FORBIDDEN", "Party is not available.");
        }
        const party = partySnap.data()!;
        if (party.status !== "active") {
          throw new BackendError("FORBIDDEN", "Party is not available.");
        }
        if (party.activeChannelId !== input.channelId) {
          throw new BackendError("FORBIDDEN", "Channel is not active for this party.");
        }
        if (!channelSnap.exists) {
          throw new BackendError("FORBIDDEN", "Channel is not registered for this party.");
        }
        const channel = channelSnap.data()!;
        if (channel.partyId !== input.partyId || channel.status !== "active") {
          throw new BackendError("FORBIDDEN", "Channel is not registered for this party.");
        }
        const storedPin = party.joinPin;
        const pinConfigured = typeof storedPin === "string" && storedPin.length > 0;
        if (pinConfigured) {
          if (!JOIN_PIN_RE.test(storedPin)) {
            throw new BackendError("FORBIDDEN", "Party is not available.");
          }
          if (input.joinPin !== storedPin) {
            throw new BackendError("FORBIDDEN", "Join PIN is required.");
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
            throw new BackendError("FORBIDDEN", "Device registration is not valid for this party.");
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
