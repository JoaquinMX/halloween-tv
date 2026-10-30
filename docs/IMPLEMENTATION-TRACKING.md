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

## Deployment readiness

**Not ready for Functions deployment or live TV activation.** The predeploy hook now builds and checks the artifact, explicit project/bucket, fixture bytes, Linux x64 binaries, normalization profile, callable exports, and task deadline. Against the source currently in this checkout it stops with clear blockers:

1. `backend/functions/src/index.ts` does not import or connect `createGenerationServices`; `runGeneration` still invokes the older delivery service whose default generation runner fails closed with `PROVIDER_UNAVAILABLE`.
2. The `runGeneration` task options do not declare `timeoutSeconds`. `generation.ts` polls for up to 720 seconds by default, so an undeclared/shorter task deadline can interrupt a worker before normalization and publication finish.
3. `backend/functions/src/providers/fake.ts` still defaults to the repository-relative `../../apps/tv_app/assets`; the deployment artifact only contains `runtime/fixtures`. The worker factory must pass the packaged fixture directory instead of assuming the repository path.
4. `apps/tv_app/lib/main.dart` constructs `WallBoot(store: PrefsManifestStore())` and an asset controller. The Firebase manifest and signed-URL packages exist, but no TV runtime composition or supported live-mode configuration selects them yet.

The code owner for the Functions source composition must connect the task to the generation service, pass the packaged `runtime/fixtures` path to the fake provider, and set a deadline that agrees with `GENERATION_WORKER_TIMEOUT_SECONDS`, `PROVIDER_POLL_TIMEOUT_SECONDS`, and `NORMALIZATION_HEADROOM_SECONDS`. The TV owner must wire explicit project, region, party, registered device, `haunted_surveillance` channel, delivery/cache, and offline fallback settings. Those files were outside this partition and were not edited here.

The runbook provides concrete future project, IAM/signing, APIs/task/scheduler, rules/index, lifecycle, build/deploy, pilot, verification, reconciliation, and rollback steps. Scripts default to preview/read-only behavior where applicable. Cloud seed and delivery verification require an explicit cloud target and explicit write/ACK flags.

## Actual deployment

**None in this cycle.** No Firebase project, bucket, rules, indexes, Functions, Scheduler job, lifecycle policy, pilot manifest, or real provider configuration was changed. Prepared files and emulator outcomes are not deployment evidence.

## Hardware validation

**None in this cycle.** No Android TV device playback, decoder behavior, network-loss transition, persistent cache behavior, or post-purge offline wall was tested. A backend callable rehearsal is not hardware validation.

## Human-gated generation and spend

**Not performed.** No Alibaba credentials or Secret Manager entries were read or changed, no provider API was called, and no live-spend mode was enabled. The cheap-demo preset and Alibaba request adapter are code-only at this checkpoint. A future approved live batch requires an owner present, a budget/limits review, per-camera task IDs, console-confirmed realized credits, and the separate record-and-reconcile procedure in the deployment runbook. Never report synthetic zero or unknown credits as a measured real charge.

## Cycle-5 verification record

Populate this section from the actual test commands run for the partition. Test success does not change deployment, device, or live-spend statuses above.

- Serial Functions suite through Node's TSX loader: 12 passed, 0 failed, 10 emulator-dependent tests skipped. This includes the new operator refusal and failed-endpoint checks and the existing real normalization tests.
- The `npm test` wrapper was attempted but the TSX CLI could not create its IPC socket in this sandbox (`listen EPERM`). The equivalent direct `node --import .../tsx/dist/loader.mjs --test --test-concurrency=1 test/*.test.ts` runner completed successfully.
- The emulator suite was attempted, but Firebase could not bind its hub/Firestore/Storage ports (`listen EPERM` on localhost); therefore the real seeder/ACK/purge integration test remains unexecuted here. Keep emulator runs serial because the Firestore emulator is shared across test files.
- `npm run build` could not resolve local `@types/node` because this checkout has no local `node_modules`; the suite used the adjacent partition's installed test dependencies. The pinned FFmpeg runtime packages are not installed in this environment. Runtime preparation was invoked and refused this non-Linux-x64 host as designed. Preflight was invoked and stopped at the missing generated runtime manifest, before source-binding checks.
