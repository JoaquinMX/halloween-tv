import { Firestore } from "firebase-admin/firestore";
import { BackendError, Identity } from "./contracts";

export interface RegisteredContext extends Identity {
  party: FirebaseFirestore.DocumentData;
  device: FirebaseFirestore.DocumentData;
  channel: FirebaseFirestore.DocumentData;
}

/**
 * Anonymous identity is the registered party/device pair. Firebase Auth UIDs and
 * email claims are intentionally neither required nor used for authorization.
 */

/**
 * Host administration gate. The host role is assigned server-side only
 * (transactional invite redemption in host_join.ts); a client-supplied role
 * string is never trusted. Every administrative operation revalidates the
 * registered host role and party/channel scope through this helper.
 */
export async function assertRegisteredHostDevice(
  db: Firestore,
  identity: Identity,
): Promise<RegisteredContext> {
  const registered = await assertRegisteredPartyDevice(db, identity);
  if (registered.device.role !== "host") {
    throw new BackendError("FORBIDDEN", "Host administration requires a registered host device.");
  }
  return registered;
}

/** TV-only gate for minting host invites: only a registered TV may invite. */
export async function assertRegisteredTvDevice(
  db: Firestore,
  identity: Identity,
): Promise<RegisteredContext> {
  const registered = await assertRegisteredPartyDevice(db, identity);
  if (registered.device.role !== "tv") {
    throw new BackendError("FORBIDDEN", "Only a registered TV may mint a host invite.");
  }
  return registered;
}
export async function assertRegisteredPartyDevice(
  db: Firestore,
  identity: Identity,
): Promise<RegisteredContext> {
  const partyRef = db.doc(`parties/${identity.partyId}`);
  const deviceRef = partyRef.collection("devices").doc(identity.deviceId);
  const [partySnap, deviceSnap] = await Promise.all([partyRef.get(), deviceRef.get()]);
  if (!partySnap.exists || !deviceSnap.exists) {
    throw new BackendError("FORBIDDEN", "Party/device pair is not registered.");
  }
  const party = partySnap.data()!;
  const device = deviceSnap.data()!;
  if (party.status !== "active" || device.status !== "active" || device.partyId !== identity.partyId) {
    throw new BackendError("FORBIDDEN", "Party/device pair is not active.");
  }
  const channelId = identity.channelId || String(party.activeChannelId ?? "");
  if (!channelId || party.activeChannelId !== channelId) {
    throw new BackendError("FORBIDDEN", "Channel is not active for this party.");
  }
  const channelRef = partyRef.collection("channels").doc(channelId);
  const channelSnap = await channelRef.get();
  if (!channelSnap.exists || channelSnap.data()?.partyId !== identity.partyId || channelSnap.data()?.status !== "active") {
    throw new BackendError("FORBIDDEN", "Channel is not registered for this party.");
  }
  return {
    partyId: identity.partyId,
    deviceId: identity.deviceId,
    channelId,
    party,
    device,
    channel: channelSnap.data()!,
  };
}
