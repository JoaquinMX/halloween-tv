import { Firestore } from "firebase-admin/firestore";
import { assertRegisteredPartyDevice } from "./auth";
import { BackendError, CurrentManifestInput, parseCurrentManifestInput } from "./contracts";

/** One registered device visible to the TV host panel. */
export interface GuestCodeEntry {
  deviceId: string;
  label: string;
  role: string;
  status: string;
}

/** Host-visible code listing for verbal guest-code dictation. */
export interface GuestCodeListing {
  partyId: string;
  channelId: string;
  tvDeviceId: string;
  devices: GuestCodeEntry[];
}

export interface GuestListServiceOptions {
  db: Firestore;
}

/**
 * Lists registered party devices for the host TV panel.
 *
 * The caller must be the registered TV device (device doc `role === "tv"`):
 * any other registered device (guests) gets FORBIDDEN, so guest codes are
 * only readable by the host TV plus the Firebase console. Callable only;
 * direct Firestore list reads stay denied by firestore.rules.
 */
export function createGuestListService(options: GuestListServiceOptions): {
  listPartyDevices(value: unknown): Promise<GuestCodeListing>;
} {
  const { db } = options;
  return {
    async listPartyDevices(value: unknown): Promise<GuestCodeListing> {
      const input: CurrentManifestInput = parseCurrentManifestInput(value);
      const registered = await assertRegisteredPartyDevice(db, input);
      if (registered.device.role !== "tv") {
        throw new BackendError("FORBIDDEN", "Only the registered TV device may list party codes.");
      }
      const snapshot = await db.collection(`parties/${registered.partyId}/devices`).get();
      const devices: GuestCodeEntry[] = snapshot.docs
        .map((doc) => {
          const data = doc.data() ?? {};
          return {
            deviceId: String(data.deviceId ?? doc.id),
            label: typeof data.label === "string" && data.label ? String(data.label) : String(data.deviceId ?? doc.id),
            role: typeof data.role === "string" ? String(data.role) : "unknown",
            status: typeof data.status === "string" ? String(data.status) : "unknown",
          };
        })
        .filter((entry) => entry.deviceId !== registered.deviceId)
        .sort((a, b) => a.label.localeCompare(b.label) || a.deviceId.localeCompare(b.deviceId));
      return {
        partyId: registered.partyId,
        channelId: registered.channelId,
        tvDeviceId: registered.deviceId,
        devices,
      };
    },
  };
}
