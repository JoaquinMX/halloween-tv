import { Firestore } from "firebase-admin/firestore";
import { assertRegisteredPartyDevice } from "./auth";
import { BackendError, CurrentManifestInput, JOIN_PIN_RE, parseCurrentManifestInput } from "./contracts";

/** One registered device visible to the TV host panel. */
export interface GuestCodeEntry {
  deviceId: string;
  /** Absent for self-registered guests: readers fall back to a neutral
   *  device-based display and never duplicate the id as label+value. */
  label?: string;
  role: string;
  status: string;
}

/** Host-visible code listing for verbal guest-code dictation. */
export interface GuestCodeListing {
  partyId: string;
  channelId: string;
  tvDeviceId: string;
  devices: GuestCodeEntry[];
  /** Present only when the party has a join PIN configured. */
  joinPin?: string;
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
          const deviceId = String(data.deviceId ?? doc.id);
          const rawLabel = data.label;
          const entry: GuestCodeEntry = {
            deviceId,
            role: typeof data.role === "string" ? String(data.role) : "unknown",
            status: typeof data.status === "string" ? String(data.status) : "unknown",
          };
          if (typeof rawLabel === "string") {
            // Whitespace-only labels normalize to absent (the TV falls back
            // to a neutral device-based display for those rows).
            const trimmed = rawLabel.trim();
            if (trimmed.length > 0) {
              entry.label = trimmed;
            }
          }
          return entry;
        })
        .filter((entry) => entry.deviceId !== registered.deviceId)
        .sort((a, b) => (a.label ?? a.deviceId).localeCompare(b.label ?? b.deviceId) || a.deviceId.localeCompare(b.deviceId));
      const listing: GuestCodeListing = {
        partyId: registered.partyId,
        channelId: registered.channelId,
        tvDeviceId: registered.deviceId,
        devices,
      };
      // Fail closed on a malformed stored PIN: a PIN-free session must never
      // be presented as valid when the stored value is present but invalid
      // (number/boolean/malformed string written via console). The TV panel
      // surfaces this as an error state with no fabricated QR.
      const storedPin: unknown = registered.party.joinPin;
      const pinUnset = storedPin === undefined || storedPin === "";
      if (!pinUnset) {
        if (typeof storedPin !== "string" || !JOIN_PIN_RE.test(storedPin)) {
          throw new BackendError(
            "INTERNAL",
            "Party join PIN is misconfigured; re-provision it with seed_join.",
          );
        }
        listing.joinPin = storedPin;
      }
      return listing;
    },
  };
}
