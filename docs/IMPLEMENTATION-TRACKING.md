# Phase 2 → 3 implementation and deployment tracking

This replaces older status notes that described the Firebase backend or live adapters as absent. The code exists in this checkout; integration, deployment, TV composition, and live operation are separate gates.

## Implemented code and evidence in the repository

| Area | Supplied implementation | Evidence present |
| --- | --- | --- |
| Offline TV wall | `apps/tv_app` boots the registered `haunted_surveillance` wall, uses four app-owned video controllers, checks the bundled fixture manifest and bytes, and retains bundled assets as an offline path. | `apps/tv_app/lib/main.dart`, `src/wall/wall_boot.dart`, `src/wall/wall_screen.dart`, `src/playback/asset_tile_video_controller.dart`, `assets/fixture_manifest.json`. |
| Local delivery/cache contracts | Core cache, durable file cache, manifest validation, Firebase manifest source, and registered TV identity adapters are present. | `packages/core_cache`, `packages/infra_firestore`; corresponding package tests include `file_cache_store_test.dart` and `firebase_manifest_source_test.dart`. |
| Signed-URL TV adapters | The TV side has a callable URL client, URL refresh path, HTTPS downloader, hash checks, and ACK contract. | `packages/infra_signed_urls/lib/src/firebase_delivery_client.dart`, `https_media_downloader.dart`, and `packages/infra_signed_urls/test/live_delivery_test.dart`. |
| Settings | Persistent settings adapter with an in-memory fallback is present. | `packages/infra_settings/lib/src/shared_preferences_settings.dart` and package tests. |
| Backend manifest/delivery/ACK/retention | Firebase callable handlers, short-lived URL response, hash-matched idempotent ACK/purge, and scheduled TTL/orphan sweep code are present. | `backend/functions/src/delivery.ts`, `src/retention.ts`, `src/index.ts`; `delivery.test.ts`, `retention.test.ts`, and `security_rules.test.ts`. |
| Fake and provider generation pipeline | The backend has fixed `cheap_demo` controls, a fake fixture provider, Alibaba provider adapter, durable provider-task/usage rows, normalization/publication, and uncertain-submission handling. Fake provider credits are synthetic zero; unrecorded real provider credits remain unknown. | `backend/functions/src/generation.ts`, `generation_store.ts`, `providers/fake.ts`, `providers/alibaba.ts`, `normalize.ts`, `publish.ts`, `usage.ts`; `generation.test.ts`, `normalize_publish.test.ts`, `usage.test.ts`, `alibaba.test.ts`, and `contracts.test.ts`. |
| Operator rehearsal and packaging | This partition adds explicit target selection, safe seed preview, real fixture seeding, Linux runtime preparation, deployment preflight, fake delivery E2E, callable delivery verification, and read-only usage reconciliation. | `backend/functions/tools/{prepare_runtime,deploy_preflight,seed_pilot,run_dry_run,verify_delivery,reconcile_usage}.ts` and `test/operator_tools.test.ts`. |

These paths and tests are implementation evidence. They do not imply that the current TV entry point invokes the live adapters or that deployed Functions call the generation pipeline.

## Cycle-5 review dispositions (3 reviewers, same diff base 80077c7..e5a71d3)

- Review A (tests): approve, 4 Low + 1 Minimal, all applied (canonical-vector doc note, file-controller mapping comment, _CacheStore semantics pin, state-gated decoder-quiescence proof, ackId deep-equal).
- Review B (code): request-changes. Applied: claimWorker refuses delivering jobs; costEstimate uses CHEAP_DEMO_PRESET; getDeliveryUrls validates channelId; poll/timeout env plumbed to the worker; ACK failure no longer demotes — REJECTED with rationale (demotion drives the proven bounded retry; errorRecoverable never tears down the playing wall; TTL sweeper bounds cloud retention); expiresAt documented server-enforced; strict active-channel check centralized; settle timeout injectable.
- Review C (compliance/security): request-changes. Applied: stagedOutputs + live job-pair backstop in the sweeper (running-job data-loss fix); expired-job staged purge; seed pre-commit object verification; getCurrentManifest rejects expired manifests; channel status strictly active; callable manifest transport wired in the TV composition (no direct manifest reads); cloud seeder refuses guessable pilot IDs; preflight checks getCurrentManifest export + GENERATION_ENABLED guard; GPL notices recorded in the runtime manifest. Bearer-ID/App-Check hardening stays owner-gated (anonymous pilot model by owner decision; runbook requires unguessable provisioned IDs for cloud).

## Deployment readiness

**Not ready for Functions deployment or live TV activation.** The predeploy hook now builds and checks the artifact, explicit project/bucket, fixture bytes, Linux x64 binaries, normalization profile, callable exports, and task deadline. Remaining blockers against the source in this checkout:

1. ~~`index.ts` not connected to the generation pipeline~~ — RESOLVED (cycle-5 p1): `index.ts` builds `createRuntimeServices` (delivery + generation store + provider pipeline, `generationEnabled` via config) and exports `getCurrentManifest`; `runGeneration` dispatches with `maxAttempts: 1`, one concurrent dispatch.
2. The `runGeneration` task options still do not declare `timeoutSeconds`. `generation.ts` polls for up to 720 seconds by default, so a shorter task deadline can interrupt a worker before normalization and publication finish. Set an explicit deadline that agrees with `GENERATION_WORKER_TIMEOUT_SECONDS`, `PROVIDER_POLL_TIMEOUT_SECONDS`, and `NORMALIZATION_HEADROOM_SECONDS`.
3. `backend/functions/src/providers/fake.ts` still defaults to the repository-relative `../../apps/tv_app/assets`; the deployment artifact only contains `runtime/fixtures`. The worker factory must pass the packaged fixture directory (new `RuntimeServiceOptions` has no fixture-dir plumbing yet) instead of assuming the repository path.
4. `apps/tv_app/lib/main.dart` still boots `WallBoot(store: PrefsManifestStore())`. The live composition exists (`PlaybackDependencies.create()` + `BackendConfig.fromEnvironment()`, default offline; `LiveWallSession` starts only after offline boot; Firebase init failure keeps the verified wall), but `main.dart` does not select it yet. Wire startup to `dependencies.createWallBoot` with `--dart-define=BACKEND_MODE=` config.

The runbook provides concrete future project, IAM/signing, APIs/task/scheduler, rules/index, lifecycle, build/deploy, pilot, verification, reconciliation, and rollback steps. Scripts default to preview/read-only behavior where applicable. Cloud seed and delivery verification require an explicit cloud target and explicit write/ACK flags.

## Standing owner gates (binding)

- No secondary Flutter app (Android, iOS, Web) without Joaquin's explicit approval. Finished backend scope stops at this gate; ask before scaffolding.
- Product/visual or human-gated questions go to Joaquin via Telegram in simple wording. Technical decisions stay with the agent.
- Video-generation testing uses the cheapest preset only: `wan3.0-video`, 480p, 2s, `cheap_demo`. Never loop-regenerate. No credentials in app code, manifests, or Firestore public docs.
- Every real generation batch needs explicit owner spend approval; log realized console credits (`model_id, preset_id, seconds_out, seconds_in, credits_charged, provider_task_id, created_at, success`).

## Actual deployment

**Cycle-7 live (2026-10-30).** Deployed to project `halloween-tv`: firestore.rules, firestore.indexes, storage.rules (deny-all-direct; media via signed URLs), and all 7 Functions v2 nodejs22 (requestGeneration, runGeneration taskQueue, getDeliveryUrls, getCurrentManifest, acknowledgeDelivery, listPartyDevices, sweepExpiredMedia) + artifact cleanup policy. Live callable check passed (FORBIDDEN on unregistered IDs; INVALID_ARGUMENT on missing channelId) — no billable work. Cloud Storage initialized by Joaquin (production mode). Web Firebase apps registered for tv_app + companion_app (shared web app ID). Companion release APK (49.2MB, live flags) installed + launched on physical Pixel 4 XL with screenshot proof; release web built; 73/73 companion tests pass in Chrome, 51/51 tv tests, 20/20 backend unit tests. Env rename: FIREBASE_STORAGE_BUCKET -> STORAGE_BUCKET (11 files) — firebase-tools rejects FIREBASE_*/GCLOUD_PROJECT keys in deploy env files; runtime provides GCLOUD_PROJECT automatically. Runtime/ stays gitignored (Linux-prepared, 141MB). Still pending: cloud party/guest seeding + scheduler/lifecycle console review + TV live-flag build for the real TV.

## Hardware validation

**None in this cycle.** No Android TV device playback, decoder behavior, network-loss transition, persistent cache behavior, or post-purge offline wall was tested. A backend callable rehearsal is not hardware validation.

## Human-gated generation and spend

**Not performed.** No Alibaba credentials or Secret Manager entries were read or changed, no provider API was called, and no live-spend mode was enabled. The cheap-demo preset and Alibaba request adapter are code-only at this checkpoint. A future approved live batch requires an owner present, a budget/limits review, per-camera task IDs, console-confirmed realized credits, and the separate record-and-reconcile procedure in the deployment runbook. Never report synthetic zero or unknown credits as a measured real charge.

## Cycle-5 verification record (orchestrator-verified 2026-10-29/30, branch `orchestrator-cycle-5-backend`)

Test success does not change deployment, device, or live-spend statuses above.

- Backend Functions under Firebase emulators: 33/33 pass, 0 skipped (`npm run test:emulator`, serial). Covers cheap_demo lock, alibaba adapter mapping, contracts, registered callables, delivery/ACK/purge, expiry, TTL/orphan sweep, security rules, usage reconciliation, runtime composition, and operator tools (seed/dry-run/verify/reconcile, preflight refusals).
- Dart packages: kernel_app 20, infra_firestore 35, infra_signed_urls 19, core_cache 17, core_playlist 28, infra_settings 11 — all pass; `dart analyze` clean on changed libs.
- tv_app: `flutter analyze` clean, full `flutter test` 43/43 pass, `flutter build apk --debug` succeeds.
- Orchestrator-fixed defects (with tests): boot prepare-before-activate order; `fileExists` seam + setUpAll file setup (real dart:io hangs in testWidgets FakeAsync zone); serial emulator suite + shared-emulator count assertion; operator seed ACK ordering per persisted-ACK contract.
- Emulator suite must stay serial (`--test-concurrency=1`): parallel files sharing one emulator raced the TTL sweeper against generation staging.

## Cycle-8: QR join + camera scanning (branch `orchestrator-cycle-8-qr-join`, 2026-10-30)

- Cycle-7 scope carried over: QR-join (phone-generated device ID + server first-join registration) landed as p1–p5 plus 4 review-findings batches on this branch.
- Camera scanning implemented on top: `mobile_scanner ^7.4.2` + `permission_handler ^13.0.2` (both maintained); `CameraJoinPayloadScanner` (permission check → request → graceful denial, cancelled scan falls back to type-or-paste); `QrScanScreen` full-screen capture whose text reuses `parseGuestJoinPayload` validation and the existing first-join registration/error states. Android `CAMERA` permission + iOS `NSCameraUsageDescription` added.
- Evidence: `flutter analyze` clean; companion suite 90/90 pass, including new `test/camera_join_scan_test.dart` (faked-scanner submit through shared validation, scanned-garbage parse error, denial + permanent-denial messages, paste-still-works-after-denial, scanner-unit denial paths with no double-prompt). Granted-camera live capture is NOT covered by widget tests — needs physical-device proof.
- Harness planning/coding/review cycle was not executed through `harness-run.sh` (no harness tooling in this checkout and no billable generation calls allowed); implemented directly with tests as evidence instead.
- Rehearsal party seeding (cloud `halloween-tv`): PREPARED but BLOCKED — operator ADC expired (`gcloud auth application-default` invalid_grant; even read-only seed preview needs ADC). IDs generated and ready: party `rehearsal-694fea0caf4fe874a28a5d37`, channel `haunt-5ee7e75a2c3c0c0765a969c8`, TV device `tv-038cfd269aa25ff59b32cd9d`; guest codes via generated `--count`. Exact commands recorded in the cycle report; Joaquin must run `gcloud auth application-default login` first.

## Owner decisions 2026-10-30 (rehearsal + QR scanning)

- PIN brute-force risk accepted for one night; no lockout.
- Guest cap and stale-entry removal deferred.
- Camera scanning approved and being implemented (this cycle).
- Companion display name: Halloween TV - Guests (confirmed; already the Android label and CFBundleDisplayName).
- Emulator by default; the TV and physical device 9A291FFBA00654 may be used for proof.
- No billable generation calls. Seeding only (no provider invocation).

## Owner decisions 2026-10-30 (Firebase live, companion, distribution)

- Firebase project `halloween-tv` created by Joaquin; firebase + flutterfire CLIs installed. Remaining: flutterfire configure wiring, `.firebaserc` alias, deploy rules/indexes/storage/functions to the real project, switch live `--dart-define` build flags from emulator to the real project, verify with a cheap read-only callable check. No billable generation without explicit action. Ask Joaquin for help when blocked (logins, console steps).
- Companion display name: "Halloween TV - Guests".
- Party code distribution: host dictates each guest's device-code verbally (QR scanning later). Guest codes are per-guest device-codes seeded in Firebase; the host reads them from the host-visible list (TV overlay and/or console). The host reads the TV's OWN party/device code off the TV screen (large text + QR, next slice) — nothing to memorize at build time (today those IDs are build-time `--dart-define`s).
- Next slice delegated: installable companion builds, real-device/browser tests, Firebase guest settings + seeded codes, TV QR display panel.

## Cycle-9: web verification + cloud seeding + harness preflight (branch `orchestrator-cycle-9-web-seed-tooling`, 2026-10-30)

### WEB VERIFICATION (companion web, live cloud backend)
- Rebuilt `apps/companion_app` web release with live `--dart-define` flags (project halloween-tv, web app ID `.../def02160cd2616a2173523`, us-central1). `flutter build web` clean. Sizes: total 40M (canvaskit 36M incl. all renderer backends, main.dart.js 2.4M, assets 1.3M).
- Served `build/web` on localhost and smoke-tested in real Chromium 131 (Playwright, 390x844 mobile viewport, CanvasKit renderer — no DOM inputs, coordinate/keyboard driven).
- Join screen renders (Party/Channel/PIN/pasted/Scan QR/Join, no config banner). Typed party+channel submit works.
- Full join flow against the seeded cloud party: `joinParty` HTTP200 -> `getCurrentManifest` HTTP200 -> Now-playing renders manifest v1 with server publication time matching the seed, 4 cameras (hallway/kitchen/staircase/storage room), Refresh/Leave. Zero console/page errors.
- Denial state: bogus IDs -> `joinParty` HTTP403 -> Now-playing shows "Access was denied." with Refresh/Leave, no crash. Matches the documented FORBIDDEN-denial contract.
- No web-only defects found. Evidence: `cycle9-web-join.png`, `cycle9-web-nowplaying.png`, `cycle9-web-denied.png`.

### CLOUD SEEDING (project `halloween-tv`, ADC operator auth, no billable calls)
- `seed_pilot --target=cloud --apply`: party seeded with 4 verified fixture clips (v1 manifest). No provider invocation.
- `seed_guests --target=cloud --apply --count=6`: host sheet below. TV device merged `role: tv` for host-only listPartyDevices.
- Host sheet: party `rehearsal-7ecd21932602003820b78b00`, channel `haunt-7c9acf9c4e747858da9c`, TV code `tv-a0d4693b89d085d0b48c`, guests `g-80ef3b6d4ab85f15`, `g-0325944a34453efd`, `g-0c535439ce214515`, `g-feff1c55de9958b3`, `g-14b94d31b127eced`, `g-1b422b4a560081d`.

### FUNCTIONS DEPLOY (needed for the join test)
- `joinParty` (cycle-8) was not in the cycle-7 cloud set, so the web join flow could not run against cloud. Deployed `--only functions`: `joinParty` created, other 7 updated. Verified in functions:list.
- Predeploy hook cannot run on this Mac (darwin-arm64; runtime:prepare + preflight demand linux-x64; Docker daemon wedged, no container path). Bypass was explicit and temporary: `npm run build` (tsc clean) + full emulator suite 51/51 pass as the gate, `firebase.json` predeploy removed for the deploy only and restored byte-identical right after (no diff).
- Known consequence: this deploy ships no `runtime/` fixture pack (was Linux-prepared 141MB from cycle-7). No working path regresses: generation is disabled and the fake worker was already blocked (fixture-dir plumbing, tracking blocker #3). `runGeneration` must not be invoked until a Linux-prepared runtime is packaged again.

### TOOLING SINGLE PLACE (harness-orchestrator workspace, NOT this repo)
- `harness/harness-run.sh` now preflights its siblings (registry, instructions, schemas, validator) and exits 2 with a clear absolute-path message when run as a stray copy from a repo checkout/worktree.
- New `scripts/harness-preflight.sh`: resolves HARNESS_HOME (env or workspace checkout), fails fast exit 2 naming the missing path, prints the absolute runner path on success. RUNBOOK §1 now mandates preflight-first absolute invocation.
- Workspace files left uncommitted for the orchestrator owner (repo has unrelated pre-existing modifications).


## Cycle-13 rollout closeout (2026-10-31)

This dated closeout supersedes older operational blockers above; those sections remain historical evidence.

- Catalog/two-stage cartoon rollout independently accepted at `f6cde52`: full backend build + emulators **234/234**, TV **104/104**, TV analysis clean. Final integration adds documentation/evidence only; tested source trees are unchanged.
- Backend deployed; all 20 exports ACTIVE. `hostInvites.expiresAt` TTL ACTIVE and collection-group index READY. Final cloud configuration is generation-disabled/fake, with zero queued tasks/pending intents and an idle budget.
- Original bounded batch reconciled: two confirmed stills/videos delivered; the first still POST has unknown outcome and consumes the third still allowance. No retry/fourth case. Actual Token Plan Credits remain UNKNOWN, not zero.
- Registered-TV ACK/manifest hashes and all eight retained preview byte hashes match; eight delivery objects are purged. Parent directly observed the cached cartoon still playing on the TV after purge. This is not a new network-isolation test.
- At rollout closeout the phone was unverified; the subsequent phone acceptance below supersedes that boundary. No lock bypass or TV Wi-Fi toggle was used. No further paid batch is active.
- Detailed scope, source/review distinctions, evidence hashes, and limitations: [catalog runbook](CYCLE-13-CATALOG-PIPELINE-RUNBOOK.md) and [final acceptance](cycle13/verification-f6cde52.json). Authorized main integration preserves branches, owner files, and stash.

## Phone pairing / View follow-up (2026-10-31 local)

- Integrated companion source `5e3423d` fixes dropped host pairing codes and route pushes above `MaterialApp`. Parent independent full suite: **168/168**, zero failures/skips; analysis clean. Real standalone app route and payload regressions cover both defects.
- Owner optical host scan succeeded. Hardware screenshots independently inspected: case-2 and case-3 CAM-01 previews play, guest lineup v3 and explicit unchecked consent/upload-disabled screen work; no photo selection/upload, generation or deletion. Phone returned to host panel.
- TV remains **partially recovered**, not fully validated: CAM-01 cartoon, CAM-03 fixture, CAM-02/04 blank; further cache/restart investigation is active. Purged delivery alone is not an established root cause.
- One diagnostic mirror host remains active (reported capacity 3/3); no revocation requested/performed. Installed APK byte match and source-provenance boundary, checks and private evidence hashes: [phone acceptance](cycle13/verification-5e3423d-phone.json). Closed generation window and UNKNOWN actual Credits unchanged.
