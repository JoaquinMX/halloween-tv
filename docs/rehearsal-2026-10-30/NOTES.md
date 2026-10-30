# Rehearsal 2026-10-30 — phone walk (live cloud `halloween-tv`)

Host sheet (cycle-9 cloud seed, same day, still valid): party
`rehearsal-7ecd21932602003820b78b00`, channel `haunt-7c9acf9c4e747858da9c`,
TV device `tv-a0d4693b89d085d0b48c`. Manifest v1 expires 2026-10-31T20:16:25Z.
Tracking doc in this checkout has no newer host sheet; cycle-9 sheet reused.

## 1. Cloud party read-only check — PASS (no billable calls)

`POST https://us-central1-halloween-tv.cloudfunctions.net/getCurrentManifest`
with party/TV-device/channel IDs returned manifest v1, 4 clips
(CAM-01..04, hallway/kitchen/staircase/storage room), createdAt
2026-10-30T20:16:27.174Z. Pure read; no generation invoked.

## 2. Builds + installs

- Companion release APK (live defines: project halloween-tv, us-central1):
  65,947,881 bytes, sha256 e8c10dac5937ac5166829da977170f510963fe35fd008a7a9bd662a87b7cef2f.
  Installed on physical Pixel 4 XL (9A291FFBA00654, USB) — confirmed via
  `adb devices` + package list.
- TV live release APK (BACKEND_MODE=firebase, party/channel/TV IDs above):
  49,993,578 bytes, sha256 98b295caed9c13ae092b9791216948095db91b97047b76c4a2aa8ff21428eb17.
  Party ID string confirmed baked into lib/arm64-v8a/libapp.so. NOT installed:
  Canvas TV has no adb reachable on LAN (port 5555 closed on all 11 live hosts
  after ping-sweep of 192.168.1.0/24); wireless debugging/pairing needs Joaquin
  at the TV.
- Build env fix (committed here): `apps/companion_app/.../build.gradle.kts`
  `compileSdk = 37` (was `flutter.compileSdkVersion` = 36; the cycle-8
  `permission_handler_android` dep requires 37). Plus local SDK symlink
  `platforms/android-37 -> android-37.0` on the Mac mini (env-only, not in repo).

## 3. Phone walk — PASS (physical Pixel 4 XL, typed codes)

- Live companion boots with no config banner; Join party screen renders.
- Typed party + channel IDs (PIN field left empty — no PIN provisioned on
  this party). Evidence: `phone-join-form-filled.png`.
- Tap Join -> first-join registration accepted -> Now playing renders
  manifest v1 with server publication time 2026-10-30T20:16:27.174Z and all
  4 cameras (hallway / kitchen / staircase / storage room).
  Evidence: `phone-now-playing-lineup.png` (last successful check
  2026-10-30T21:04:53Z).
- Mid-walk finding: phone had no network (Wi-Fi off-network, mobile data off);
  Joaquin reconnected it, Refresh then loaded the lineup. Temporarily enabled
  `svc data` for diagnosis, turned back off afterwards.

## 4. NOT done — needs Joaquin at the Canvas TV

- Install live TV APK over network (needs wireless debugging + IP/pairing code).
- Confirm now-playing + TV guest list (`listPartyDevices` host panel).
- Kill TV Wi-Fi mid-playback to prove cached playback continues; reconnect
  and confirm resync.

## Open questions

- TV wireless-debugging access (IP + pairing code), and whether the TV is on
  the same 192.168.1.x LAN.
- Docker daemon on the Mac mini never answered (`docker ps` hung) — not
  needed for this rehearsal, but Linux runtime prep stays blocked until it
  recovers.

## 5. TV diagnosis — baked channel vs seeded channel (root cause of offline wall)

- First live TV build (party `rehearsal-7ecd…`) booted to the verified offline
  wall; recovery panel said "Wall running on local fixtures" and the guest
  panel failed with "unexpected guest list failure".
- Cause: the TV hardcodes channel `haunted_surveillance`
  (`packages/channel_cctv/lib/src/plugin.dart`), but the cycle-9 party's
  ACTIVE channel is the generated `haunt-7c9acf9c4e747858da9c`. Server
  (`auth.ts`) requires `activeChannelId === channelId`, so every TV-identity
  call with `haunted_surveillance` was rejected. The TV live path fails
  closed to the offline wall by design — no crash, no fabricated state.
- Fix within approved tooling: seeded a NEW party whose active channel IS
  `haunted_surveillance` (new `seed_pilot cloud --apply`, no provider calls):
  party `rehearsal-e845ecefdcd7a7e047c607a5`, TV
  `tv-a0d4693b89d085d0b48c`, channel `haunted_surveillance`, manifest v1
  (same 4 fixture hashes), expires 2026-10-31T21:14:02Z. Then
  `seed_guests cloud --count=6 --apply` for the host sheet:
  g-ce554d87f04385e2, g-a8d2618b18492d9e, g-e9efd5d907c3abd0,
  g-cd96fe3c1a61e80b, g-06f9e6b8596681f2, g-a9516bb56cc6c0b2.

## 6. TV live install + host panel — PASS (Canvas TV 192.168.1.19, adb network)

- Rebuilt TV live APK with `TV_PARTY_ID=rehearsal-e845ecefdcd7a7e047c607a5`
  (50,015,XXX bytes, sha256 69ef1abbb460b18289eb60130a3ebbfe05ef6c81cdc624115;
  party string confirmed in lib/arm64-v8a/libapp.so). Uninstalled the stale
  debug-signed build, installed release, confirmed via `adb devices`.
- TV boots the 2x2 wall (Evidence: `tv-wall.png`). Guest codes panel shows
  the TV code, `party rehearsal-e845… · haunted_surveillance · no PIN
  required`, a session QR, and the 6 seeded guests
  (Evidence: `tv-guest-codes-qr.png`).
- Phone rejoined the NEW party via retyped codes: join accepted, Now playing
  shows manifest v1 published 2026-10-30T21:14:04Z + 4 cameras
  (Evidence: `phone-new-party-lineup.png`).
- TV guest list then shows all 6 seeded guests PLUS the phone as
  "Guest device: p-2f47257f15aebbedd1cc134cb647c7c8"
  (Evidence: `tv-guest-list-with-phone.png`). Full join→host-panel loop
  proven live on hardware.

## 7. BLOCKER — `getDeliveryUrls` 500s, wall stays on local fixtures

- The TV polls `getDeliveryUrls` every few seconds (userAgent okhttp in cloud
  logs); each returns HTTP 500 `INTERNAL`. `getCurrentManifest`,
  `joinParty`, and `listPartyDevices` all work — only the signed-URL step
  fails. Per `delivery.ts`, INTERNAL here can only come from `signReadUrl`
  (`file.getSignedUrl` v4) throwing.
- IAM read-back: the functions runtime SA
  `897751802522-compute@developer.gserviceaccount.com` has ZERO bindings on
  itself — no `roles/iam.serviceAccountTokenCreator`, so v4 signing cannot
  work. This was never exercised before: cycle-7/9 only tested validation
  paths (FORBIDDEN/INVALID_ARGUMENT), never a successful delivery URL.
- Needed Joaquin/owner console-or-gcloud one-liner (IAM change, outside the
  seeding-only approval, so NOT applied here):
  `gcloud iam service-accounts add-iam-policy-binding 897751802522-compute@developer.gserviceaccount.com --member=serviceAccount:897751802522-compute@developer.gserviceaccount.com --role=roles/iam.serviceAccountTokenCreator --project=halloween-tv`
- Wi-Fi-kill cached-playback test NOT run: with the wall on bundled fixtures
  (not cached cloud clips) the test would be misleading, and the resync half
  cannot succeed until delivery URLs mint. Run it right after the IAM grant
  when the wall shows the live session.

## Open questions

- Same as §4 + the IAM grant above. After the grant: re-run TV wall check,
  then Wi-Fi kill/resync, then close out.
- gcloud CLI user auth on the Mac mini is expired (`invalid_grant`); ADC file
  (refreshed 14:08 today) still works for tools + read-only REST. Joaquin
  may want to `gcloud auth login` at some point.

## 8. Resume pass — reinstalls + fresh join re-walk (15:24–15:26 CST)

- Reinstalled both release builds (`adb install -r`, Success on both);
  `adb devices` confirms `9A291FFBA00654 device` + `192.168.1.19:5555 device`.
- Cloud read-only re-check: `getCurrentManifest` returns v1 + 4 clips for
  party `rehearsal-e845…` / `haunted_surveillance`; `getDeliveryUrls`
  STILL returns 500 INTERNAL — signing blocker (§7) persists.
- Phone (reinstall cleared session): retyped new party + `haunted_surveillance`,
  Join accepted, Now playing v1 published 2026-10-30T21:14:04Z, last check
  2026-10-30T21:25:11Z, 4 cameras. Evidence: `phone-rejoin-lineup.png`.
  (Note: `install -r` kept app data, so the phone kept device ID
  `p-2f47257f…`; server took the existing-registration path.)
- TV guest panel re-verified live: QR + TV code + 6 seeded guests + phone
  `p-2f47257f…`. Evidence: `tv-guest-panel-live.png`, `tv-guest-list-full.png`.

## 9. Wi-Fi kill test — OUTAGE IN PROGRESS, TV offline since ~15:27 CST

- Baseline wall screenshot `wifi-before.png` (all tiles playing, 15:26:59).
- `svc wifi disable/enable` FAILS on this Hisense ROM
  ("Failure calling service wifi: Failed transaction" — logged).
- `cmd wifi set-wifi-enabled disabled` WORKED: adb-over-WiFi dropped
  immediately ("error: closed"), TV now `offline` in `adb devices`, connect
  attempts time out. No remote re-enable path exists (no USB adb).
- WAITING ON JOAQUIN: turn TV Wi-Fi back on via remote
  (Settings → Network → Wi-Fi). After reconnect I will verify: wall still
  playing with current timestamps (proves uninterrupted offline playback
  through the outage), guest panel refreshes (resync of working callables),
  and record the outage window. Cloud-cache variant stays blocked on §7.

## 10. IAM grant applied by Joaquin — delivery chain FULLY VERIFIED (15:32 CST)

- Joaquin ran the §7 one-liner; SA now holds
  `roles/iam.serviceAccountTokenCreator` (confirmed in his terminal output).
- `getDeliveryUrls` (TV identity) now returns manifestVersion 1,
  manifestHash `42314580…`, and 4 clips with v4 signed URLs
  (`X-Goog-Credential=897751802522-compute@…`, 900s expiry).
- Downloaded CAM-01 through its signed URL: 84,275 bytes, sha256
  `d378a607…` — EXACT manifest match. Cloud → signed URL → bytes → hash
  chain proven end to end. No provider calls, no spend (tiny egress only).
- REMAINING: TV Wi-Fi still OFF (`adb` → `192.168.1.19:5555 offline`,
  connect times out). Once Joaquin re-enables it: expect the wall to
  upgrade from bundled fixtures to the live session automatically
  (it has been polling delivery every few seconds), then verify live wall
  + guest resync + close out the Wi-Fi outage window.
