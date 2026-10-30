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

**None in this cycle.** No Firebase project, bucket, rules, indexes, Functions, Scheduler job, lifecycle policy, pilot manifest, or real provider configuration was changed. Prepared files and emulator outcomes are not deployment evidence.

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
