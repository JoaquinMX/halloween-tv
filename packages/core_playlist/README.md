# core_playlist

Playback manifest domain model for Halloween TV: CCTV camera contracts,
manifest parsing, and validation shared by every layer.

## Camera identity (single source of truth)

`cctvSlots` is the canonical wall order, camera ids (`CAM-01`–`CAM-04`),
and default room labels. Tile maps, asset catalogs, and label resolution
derive from it; no `CAM-0x` literals are duplicated in other layers.

## Configurable 1/2/4-camera layouts

Supported manifest clip counts are exactly **1, 2, or 4**
(`kSupportedCctvClipCounts`); **four is the default** when the
`cameraCount` setting (a SettingsPort display cap owned outside this
package) is absent, invalid, or unreadable (`kDefaultCctvClipCount`).

- `isSupportedCctvClipCount` / `expectedCctvCameraIds` are the shared
  prefix helpers: a count-`N` manifest must carry exactly the first `N`
  canonical slot ids in wall order. Backend `contracts.ts`
  (`SUPPORTED_CAMERA_COUNTS`, `expectedCameraIds`) mirrors them.
- `validateCctvManifest` accepts 1, 2, or 4 clips with unique clip ids and
  a camera set equal to the first-`N` prefix. Reordered valid clips remain
  accepted; unsupported counts, gaps (e.g. `{CAM-01, CAM-03}` for count 2),
  duplicates, unknown cameras, and invalid existing metadata are rejected.
- The cap is display-only: generation presets keep producing 4 clips, and
  reduced layouts still prepare + ACK the complete received manifest
  (see `PreparePlayback` and the delivery ACK client).
- Count vectors live in `test/fixtures/cctv_counts_v1.json`; the legacy
  four-camera hashes are preserved byte-identically.

## Host entry rationale (pointer)

The companion uses a dedicated host entry screen (`HostEntryScreen` with
Scan Host QR + an explicit Join-as-guest route) so host administration can
never be reached through the guest PIN or a client-supplied role string.
The contract half of that boundary (server-minted invites, server-assigned
host role, host-gated seed catalog) is documented in
`docs/backend-contract-v1.md`; this package only carries the camera-count
side of the shared contracts.
