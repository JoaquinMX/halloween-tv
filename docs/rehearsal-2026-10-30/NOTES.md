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
