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

## 11. Wi-Fi outage CLOSED — offline continuity + live resync PROVEN (15:27→15:34 CST)

- Outage: `cmd wifi set-wifi-enabled disabled` at ~15:27:14 (device log);
  Joaquin re-enabled via remote ~15:34 (Totalplay-546A-5G Conectado).
  `svc wifi` does NOT work on this Hisense ROM (Failed transaction) —
  recorded for the runbook.
- Continuity: app process `com.joaquinmx.tv_app` alive 10+ min across the
  outage (never restarted/crashed); wall kept playing on local media with
  zero network (baseline `wifi-before.png` 15:26:59 → still playing after).
- Resync: within ~90s of Wi-Fi return the wall showed "WALL UPDATED · v1"
  (Evidence: `wall-live-v1.png`, 15:35:35) — the live session downloaded the
  cloud clips over the fixed signed URLs, hash-verified, ACKed, and swapped
  all 4 tiles to verified remote media (code: `_activateLiveVersion`
  requires complete verified media; the recovery panel's "local fixtures"
  line is static help text, not a status readout).
- Guest panel resynced post-reconnect: TV code + party/channel + QR + guest
  list (Evidence: `guest-panel-resync.png`). Outage window closed, no gaps.
- REHEARSAL COMPLETE: cloud check ✓, both installs ✓, phone typed-join +
  lineup ✓ (both parties), TV host panel + guest list incl. phone ✓,
  offline continuity ✓, live resync ✓. Only emulator-side item carried
  over unchanged; no code changed this pass.

## 10. Cycle-11 guest chain + fake rehearsal + TV ACK (orchestrator-executed 2026-10-30/31)

- P0 camera fix proven on Pixel 9A291FFBA00654: camera opens on grant (Joaquin-confirmed), typed join reaches live lineup (screenshot cycle11-camera-lineup.png), live camera frame (cycle11-camera-preview.png).
- Backend 80/80 + companion 104/104 serial suites green on merged tip (incl. consent-gating, withdrawal races, empty-fixture closedown, memory-floor + trigger-region preflight tests).
- Deployed to halloween-tv: 13 functions (4 guest callables + onGuestIngestFinalized us-east1), rules/indexes/storage. Fixes found by deploy, not review: storage trigger region (bucket is US-EAST1, Eventarc SA granted storage.viewer), worker OOM at 256MiB (raised to 1GiB GENERATION_WORKER_MEMORY + preflight floor).
- Fake E2E (zero provider calls): job c11-fake-04 on rehearsal-c11-fake-01/haunted_surveillance (TV watches literal haunted_surveillance — party activeChannelId aligned), 1 fake submit CAM-01 normalized to generated-shape H.264/yuv420p/24fps/854x480/2s + 3 fixture slots, manifest v2. Physical TV downloaded, hash-verified, WALL UPDATED v2 on screen (cycle11-tv-generated.png), ACKed (deliveryAckId c9688...), job purged, post-purge playback retained (cycle11-tv-post-purge.png). Reconcile: providerApiCalls=0, CAM-01 synthetic_zero; fixture slots unknown/null by design.
- Rehearsal window still OPEN (GENERATION_ENABLED=true + fake, predeploy --allow-generation): must restore disabled + redeploy after live batch. Stuck job c11-fake-02 marked failed (worker OOM, maxAttempts 1).
- PENDING: live cheap_demo (wan3.0-video 480p 2s) needs ALIBABA_API_KEY + ALIBABA_WORKSPACE_ID from Joaquin (no Secret Manager on project; .env.halloween-tv is gitignored and deploy-safe). Spend pre-approved ≤5 attempts with realized-credit logging.
- Known gaps: emulator Storage lacks XML PUT route (signed-PUT proven on cloud instead); TV live channel is a hardcoded constant (single-party assumption, flagged for review).

## 11. Cycle-11 review fix wave (3 reviewers, orchestrator-merged 2026-10-30/31)

- Review A (tests): 1 Minimal — tautological hash assert in guest_upload.test.ts, fixed to digest photoBytes.
- Review B (code, spark): 3 High — client required echoed contentType the backend never returns (all uploads would fail), complete/status/withdraw omitted channelId, withdraw rejected backend 'withdrawn'; 2 Medium — Navigator FlutterError catch, lazy provider dropping fixtureDirectory; 1 Low — stale budget pointer on withdraw; 1 Minimal — hardcoded jpeg + duplicated consent literals. All fixed with failing-first regressions.
- Review C (compliance): 2 High+ — withdrawal verifiedAbsent checked source only (derivatives could survive + manifest stayed deliverable); completion-vs-withdrawal race could re-eligible a tombstone and publish accepted it. 3 High — client incompat (concurs B), rehearsal tool checked only the LOCAL provider flag (a remote-alibaba mismatch could submit live billable work), single-receipt overwrite orphaned earlier submissions. 3 Medium — 10MB checked after full download, expiry reset on completion, reconcile counted unknown-credit rows as zero API calls (false zero-spend). All fixed: tombstone-first withdrawal with full-object verifiedAbsent, transactional completion vs fresh consent, server-persisted rehearsalOnly marker (worker resolves fake-only under marker, fails closed otherwise), per-submission scoped receipts, size-first validation, immutable creation-based deletion deadline, provenance-based providerApiCalls (live-shaped rows with null credits count >0, unknown never zero).
- Post-merge validation (orchestrator): backend serial emulator suite 92/92 (was 80/80), companion flutter analyze clean + 111/111 serial (was 104/104). Conflict in generation.ts (fixtureDirectory threading vs rehearsal guard) stitched, tsc clean.
- Still open: live cheap_demo batch (wan3.0-video 480p 2s, ≤5 attempts pre-approved) BLOCKED on ALIBABA_API_KEY + ALIBABA_WORKSPACE_ID from Joaquin (no Secret Manager on project). Generation window still open (GENERATION_ENABLED=true + fake, temporary predeploy --allow-generation uncommitted). Zero provider API calls to date.

## 12. Step-1 live batch outcome (orchestrator-executed 2026-10-31 ~00:30-00:50 CST)

- Owner approval: Telegram 23:22 CST "Do step 1 and 2". Preflight --allow-live-batch=telegram-20261030-2322-step1 seam added via harness (reviewed pattern), deployed, used, window closed after (GENERATION_ENABLED unset, provider fake, redeploy verified, predeploy restored).
- Step 1 ran as TEXT-ONLY cheap_demo job c11-live-01 — and text-only jobs use FOUR provider cameras (generation.ts:273-275; guest-bound jobs use 1+3). Orchestrator scope error: this consumed attempts 2,3,4,5 in one job instead of a single clip. Probe budget now 5/5 EXHAUSTED (1 tonight direct + 4 pipeline). No further live submissions without fresh approval.
- Results: 4 real Alibaba task IDs; CAM-01..03 retrieved, normalized to generated-shape, staged; CAM-04 poll timed out at 720s (PROVIDER_UNAVAILABLE, task retained); job did not reach ready, current manifest stays v2 (fake-04, TV-ACKed). Staged live clips were NOT published (pipeline only publishes complete 4-clip sets; no partial publish done).
- Credits: all 5 rows UNKNOWN — provider omits credits_charged (same as tonight's direct run). Realized debit requires Joaquin's console check. Reconcile (fixed counting) reports providerApiCalls=4 live submissions, never zero.
- Step 2 (5s Scooby + reference) is ON HOLD: needs (a) fresh spend approval (budget exhausted), (b) preset change 2s->5s + reference-image input billing (code change, harness), (c) pricing confirmation (5s out + possible input billing).
- Follow-ups for next cycle: enforce single-submit scope for live batches (guest-bound or explicit single-camera job type); review the 720s poll timeout vs provider latency; decide fate of the 3 staged live clips (leave staged under retention TTL).
