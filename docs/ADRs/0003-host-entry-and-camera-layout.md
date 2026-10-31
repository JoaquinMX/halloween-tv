# ADR 0003 — Dedicated host entry, camera display cap, and invite/PIN separation

- Status: accepted
- Date: 2026-10-31
- Partition: fix-2 apps security + polish (Halloween TV cycle-12)

## 1. Dedicated host entry screen (separate from guest PIN admission)

Decision: the companion boots to a dedicated `HostEntryScreen` (Scan Host
QR + paste fallback + explicit "Join as guest" route) instead of a single
join form with a role toggle.

Rationale: guest PIN admission is intentionally broad — anyone who can see
the TV screen can self-register as a guest. Host administration must never
be reachable through the guest PIN or a client-supplied role string, so
the two routes stay visibly distinct and the privilege boundary stays
auditable: host payloads redeem only through `joinHost` (separate phone
identity, server-assigned `host` role) while guest payloads register only
through `joinParty`.

Consequences:
- The host QR carries a server-minted, short-lived invite capability
  (`inviteToken`) plus a 6-digit `pairingCode` shown next to the QR; both
  are required by `joinHost`, and a wrong code denies exactly like an
  unknown invite (generic `FORBIDDEN`, no oracle).
- The entry screen collects the pairing code in its own field (manual
  entry authoritative; a code inside a scanned/pasted payload only
  prefills an empty field — scan/paste parity), validates it locally
  (6 digits, no network on failure), and surfaces denial as the generic
  sanitized message only.

## 2. Camera display cap (`cameraCount` key, encoding, default)

Decision: `cameraCount` is a display cap only, persisted through the
existing party-scoped `SettingsPort` string key
(`CctvWallSettingsKeys.cameraCount`) with values `'1'` / `'2'` / `'4'`
(surrounding whitespace tolerated, raw ints accepted defensively) and a
default of `4` (`kDefaultCctvClipCount`) for anything absent, invalid, or
unreadable.

Rationale: the setting can only ever HIDE cameras, never invent them —
`cctvEffectiveCount = min(configured, manifest clips)` — while prepare /
verify / ACK always cover the complete received manifest. Generation
presets keep producing 4 clips and reduced layouts still ACK the full
manifest, so `1`/`2`-camera manifests flow through the real mapping,
durable-cache, delivery, and ACK paths. `isSupportedCctvClipCount`
(1, 2, 4) is the shared gate on both sides; the wall fails closed
(SIGNAL-LOST/cache state, no `StateError` out of construction) on any
other manifest length.

## 3. Host-invite vs guest-PIN separation

Decision: the guest QR is `partyId + channelId + role: 'guest'` plus an
optional six-digit `joinPin`; the HOST QR is `partyId + channelId +
role: 'host'` plus `inviteToken + pairingCode`. A PIN-shaped token never
redeems host access (rejected client-side and by `parseJoinHostInput`),
a host payload never carries a `joinPin`, and client-supplied role
strings are ignored — the backend assigns `host` server-side,
transactionally, bound to party/channel/expiry.

Consequences: legacy guest payloads without `role` stay parseable
(role-absent means guest); unknown roles fail visibly; guest payloads
submitted on the host entry (or vice versa) fail before any callable.

## 4. Preview/delivery separation + host revocation

Decision: previews are fresh scoped capabilities per view
(`getHostVideoPreview` → short-lived signed URLs, never persisted),
while delivery manifests are the only durable playback artifact. Deletion
is per selected seed id (previews + delivery objects removed, affected
current manifest revoked, accounting records preserved) behind a
confirmation dialog naming the seed(s), reconciled only after
authoritative success so failures stay retryable in place.

Host management on the TV (`revokeHostDevice`, TV-only) lists active
hosts as LABELS ONLY — device ids never render — and revokes by opaque
id behind a second confirmation naming the label; the row stays until
the server confirms.
