# Firebase deployment and operator runbook

This is a command and evidence checklist. Commands containing placeholders are examples only; no project was deployed or changed for this cycle. Keep Phase 3 on the fake provider until the owner separately approves live generation.

## Current stop checks

The repository contains the generation and delivery service modules plus the TV Firebase client adapters, but the current production composition is not ready to deploy end to end:

- `backend/functions/src/index.ts` still builds the task handler with the older `createDeliveryServices` service and its default runner returns `PROVIDER_UNAVAILABLE`. It does not connect `createGenerationServices`, and it does not declare a task `timeoutSeconds`. The new predeploy gate intentionally fails until both are connected and the configured worker deadline is present in that handler.
- `backend/functions/src/providers/fake.ts` defaults to the repository path `../../apps/tv_app/assets`; deployed packages only contain `runtime/fixtures`. Wire the packaged fixture directory into the worker's fake-provider construction before deploying.
- `apps/tv_app/lib/main.dart` still boots the local `WallBoot` with bundled assets and `PrefsManifestStore`. The Firebase manifest, callable delivery, and settings adapters exist in packages, but the TV entry point does not yet select or construct them. There is no supported `--dart-define` live switch in this checkout. Do not mark a TV as live or use guessed compile flags.

Keep the wall in offline mode until the relevant app/runtime owners land those composition changes and their tests. Once wired, use the exact values in the TV configuration section below and capture the runtime evidence before enabling devices.

## 1. Select the project and bucket explicitly

Set the resource names from the approved change ticket. The Functions runtime reads the bucket from `FIREBASE_STORAGE_BUCKET`; never rely on the Admin SDK default bucket.

```sh
export PROJECT_ID='<FIREBASE_PROJECT_ID>'
export BUCKET='<EXISTING_FIREBASE_STORAGE_BUCKET>'
export REGION='us-central1'
gcloud config set project "$PROJECT_ID"
gcloud projects describe "$PROJECT_ID" --format='value(projectId,projectNumber)'
gcloud storage buckets describe "gs://$BUCKET" --format='value(name,location,storageClass)'
```

Expected evidence: the project ID, project number, and bucket name/location match the approved record. Confirm bucket ownership and retention impact with the project owner before continuing.

For an isolated local run, use a demo project and emulator bucket only:

```sh
export GCLOUD_PROJECT='demo-halloween-tv'
export FIREBASE_STORAGE_BUCKET='demo-halloween-tv.appspot.com'
export FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
export STORAGE_EMULATOR_HOST='127.0.0.1:9199'
```

The scripts reject a partial emulator pair, mixed emulator/cloud targets, and cloud commands without an explicit target. Never copy the emulator values into a cloud `.env.<project>` file.

## 2. Operator ADC and IAM prerequisites

Use the operator's Application Default Credentials (ADC), not a service-account key file:

```sh
gcloud auth application-default login
gcloud auth list
gcloud auth application-default print-access-token >/dev/null
```

The operator needs the organization's approved Firebase/Cloud deployment roles, including Functions deployment, Cloud Build and Artifact Registry access, Service Usage, and `iam.serviceAccounts.actAs` on the selected runtime service account. Review current bindings before asking an IAM administrator to grant anything:

```sh
gcloud projects get-iam-policy "$PROJECT_ID" --format='table(bindings.role,bindings.members)'
gcloud iam service-accounts list --project "$PROJECT_ID" --format='table(email,disabled)'
```

The runtime service account needs only the resources required by the worker, including Firestore access, bucket object read/write/delete for delivery and retention, Cloud Tasks enqueue/dispatch access, and permission to sign V4 read URLs. For V4 signed URLs using IAM signing, the caller must have `iam.serviceAccounts.signBlob` through `roles/iam.serviceAccountTokenCreator` on the signing service account. Verify the grant on the actual signer identity; a successful local emulator URL is not evidence of cloud signing permission.

Expected evidence: recorded operator principal, runtime service account email, IAM review, and a successful `iam.serviceAccounts.signBlob` permission check by the project administrator. Do not place key material in `.env`, source, Firestore, or the TV app.

## 3. Enable and verify platform services

Ask the project owner to approve APIs before enabling them. The deployment needs Cloud Functions/Cloud Run, Cloud Build, Artifact Registry, Eventarc, Cloud Tasks, Cloud Scheduler, Firestore, and Cloud Storage APIs.

```sh
gcloud services list --enabled --project "$PROJECT_ID" --format='value(config.name)' | sort
gcloud tasks queues list --location "$REGION" --project "$PROJECT_ID"
gcloud scheduler jobs list --location "$REGION" --project "$PROJECT_ID"
```

Expected evidence: required APIs are enabled; the task queue and Scheduler service agents are provisioned; the chosen region is consistent with Functions (`us-central1`) and the project configuration. Do not create queues or scheduled jobs by hand unless the owner explicitly approves that project change.

## 4. Prepare the Linux Functions artifact

The artifact contains compiled Functions, pinned Linux x64 FFmpeg/ffprobe packages copied to `functions/runtime/bin/`, and the four playable fixture MP4 files copied to `functions/runtime/fixtures/`. `src/normalize.ts` reads `FFMPEG_PATH` and `FFPROBE_PATH`, and the fake E2E passes the packaged fixture directory explicitly. The current deployed worker factory has not yet been wired to that path; preflight blocks deployment until it no longer depends on `../../apps/tv_app/assets`.

Build on an x64 host with Node.js 22. The Linux binaries are platform-specific; if developing from macOS, run the packaging step in an approved Linux x64 build container or CI worker. `runtime/` and local verification output are ignored by Git but included in the Firebase Functions source archive.

```sh
cd backend/functions
npm ci --force
export GCLOUD_PROJECT="$PROJECT_ID"
export FIREBASE_STORAGE_BUCKET="$BUCKET"
export GENERATION_WORKER_TIMEOUT_SECONDS='900'
export PROVIDER_POLL_TIMEOUT_SECONDS='720'
export NORMALIZATION_HEADROOM_SECONDS='120'
npm run build
npm run runtime:prepare
npm run preflight -- --target=cloud --project="$PROJECT_ID" --bucket="$BUCKET"
```

Expected evidence from `runtime:prepare`: `target=linux-x64`, both executable paths, four fixture hashes/sizes, and the H.264/yuv420p/24fps/480P/two-second normalization profile. Expected evidence from preflight: compiled `package.json` entry point, exact bucket and project, fixture digests, and worker deadline matching the task handler.

With the current `src/index.ts`, the final preflight command must stop and report the missing `createGenerationServices` task binding and `timeoutSeconds`; resolve those source integration checks before any deploy command. A successful TypeScript build alone is not deployment readiness.

## 5. Configure runtime environment and verify worker deadlines

Create `backend/functions/.env.<PROJECT_ID>` locally or in the approved deployment environment. This file is ignored and must contain no provider credentials. Do not copy `backend/functions/.env.example` as-is because it contains emulator endpoints.

```dotenv
GCLOUD_PROJECT=<FIREBASE_PROJECT_ID>
FIREBASE_STORAGE_BUCKET=<EXISTING_FIREBASE_STORAGE_BUCKET>
VIDEO_GENERATION_PROVIDER=fake
FFMPEG_PATH=/workspace/runtime/bin/ffmpeg
FFPROBE_PATH=/workspace/runtime/bin/ffprobe
GENERATION_WORKER_TIMEOUT_SECONDS=900
PROVIDER_POLL_TIMEOUT_SECONDS=720
NORMALIZATION_HEADROOM_SECONDS=120
DELIVERY_URL_TTL_SECONDS=900
# Optional (defaults shown): PROVIDER_POLL_INTERVAL_MS=15000 PROVIDER_TIMEOUT_MS=720000
```

Expected evidence: deployment config resolves to the same project/bucket as step 1, has no emulator host variables, and starts with `VIDEO_GENERATION_PROVIDER=fake`. The worker timeout must be no shorter than polling plus normalization headroom and must match the `timeoutSeconds` declared by the task handler. The preflight refuses missing or inconsistent values.

Sizing note: the worker polls cameras sequentially, so the worst case is roughly four single-camera poll budgets plus normalization. The checked-in 900s task deadline fits fake-provider runs (seconds) and typical fast provider jobs, not four back-to-back 12-minute worst cases. Size `GENERATION_WORKER_TIMEOUT_SECONDS` (and the handler `timeoutSeconds`) for the provider you approve, keep `maxAttempts: 1`, and rely on crash reconciliation plus explicit re-request — never silent auto-retry — if a dispatch dies mid-pipeline.

Do not set an Alibaba provider mode, live-spend switch, provider API key, or Secret Manager value in this phase. A later live batch requires a separate human approval, budget cap, and owner present in the Alibaba console.

## 6. Apply rules and indexes

Review the rules and the collection-group `jobs.expiresAt` index in the branch, then deploy them before Functions:

```sh
cd backend
firebase --config firebase.json deploy --project "$PROJECT_ID" --only firestore:rules,firestore:indexes,storage
```

Expected evidence: Firebase CLI reports Firestore rules, the `jobs.expiresAt` collection-group index, and Storage rules deployed. Verify in Firebase Console that clients cannot read/write manifests, jobs, ACKs, cost logs, or Storage objects directly; registered-device reads remain the only direct client exception.

## 7. Apply and read back Storage lifecycle policy

The Functions sweeper is scheduled every 15 minutes and uses per-object `expiresAt` metadata to expire jobs, delete expired objects, and remove unreferenced objects. Add a bucket-level safety lifecycle action for the same object custom time. The sample deletes objects one day after their custom time; confirm this matches the approved retention policy before applying it.

```sh
cat > /tmp/halloween-tv-lifecycle.json <<'JSON'
{
  "rule": [
    {
      "action": { "type": "Delete" },
      "condition": { "daysSinceCustomTime": 1 }
    }
  ]
}
JSON
gcloud storage buckets update "gs://$BUCKET" --lifecycle-file=/tmp/halloween-tv-lifecycle.json --project "$PROJECT_ID"
gcloud storage buckets describe "gs://$BUCKET" --project "$PROJECT_ID" --format=json
```

Expected evidence: bucket description read-back includes the approved `Delete` rule with `daysSinceCustomTime: 1`. Save the read-back in the deployment record. The bucket lifecycle is a backstop and does not replace the scheduled Firestore/object reconciliation.

## 8. Deploy Functions after gates pass

Only after the connected generation service, task timeout, IAM, rules/index, lifecycle, and runtime config checks pass:

```sh
cd backend/functions
export GCLOUD_PROJECT="$PROJECT_ID"
export FIREBASE_STORAGE_BUCKET="$BUCKET"
npm run predeploy
cd ..
firebase --config firebase.json deploy --project "$PROJECT_ID" --only functions
firebase --config firebase.json functions:list --project "$PROJECT_ID"
```

The Firebase predeploy hook runs build, runtime preparation, and deployment preflight again. Expected evidence: the build entry point and artifact checks pass, callable/task/scheduler exports appear in `functions:list`, and Cloud Logs show the worker and scheduler initialize without bucket, signing, or deadline errors. Do not treat a prepared artifact, a successful emulator, or this runbook as a deployment.

## 9. Register and verify a fixture pilot

Use a dedicated party/device and the `haunted_surveillance` channel. Preview first. The emulator form is safe for rehearsal:

```sh
cd backend/functions
export FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
export STORAGE_EMULATOR_HOST='127.0.0.1:9199'
export GCLOUD_PROJECT='demo-halloween-tv'
export FIREBASE_STORAGE_BUCKET='demo-halloween-tv.appspot.com'
npm run seed:pilot:preview -- --party=pilot --device=tv-pilot --channel=haunted_surveillance
npm run seed:pilot:apply -- --party=pilot --device=tv-pilot --channel=haunted_surveillance
```

The seeder defaults to preview. It uses the repository's real MP4 fixture bytes, computes SHA-256 and sizes, writes stable version-1 publication metadata and a `ready` fixture job with a 24-hour expiry, and does not replace an unrelated/newer current manifest. Repeating the exact seed is a no-op; after ACK changes the job to `purged`, the seed refuses to recreate deleted objects.

For a future owner-approved cloud fixture seed, select the cloud target and provide all four explicit options; first omit `--apply` to preview. Party/device IDs are the TV authorization credential (no login gate by owner decision), so a real deployment must use unguessable provisioned values — never the `pilot` / `tv-pilot` emulator defaults, which the cloud seeder refuses. Pairing additions and App Check enforcement remain future hardening; today, ID secrecy plus least-privilege rules is the boundary.

```sh
npm run seed:pilot:cloud -- --project="$PROJECT_ID" --bucket="$BUCKET" --party='<PILOT_PARTY>' --device='<REGISTERED_TV_DEVICE>' --channel=haunted_surveillance
npm run seed:pilot:cloud -- --project="$PROJECT_ID" --bucket="$BUCKET" --party='<PILOT_PARTY>' --device='<REGISTERED_TV_DEVICE>' --channel=haunted_surveillance --apply
```

Expected evidence: four playable MP4s; matching fixture, object, and manifest hashes/sizes; manifest `createdAt`; registered party/device/channel; and a matching ready job with the same version, expiry, and delivery paths. Cloud seeding is a project mutation and was not run in this cycle.

Run the fake generation E2E against emulators. It checks all four cost rows before/after the fake provider, provider-task bindings, exact hash ACK, repeated ACK, object deletion, and durable local file hashes after purge:

```sh
npm run fake:e2e
```

Expected evidence: JSON `mode=fake-emulator-e2e`, `billableCalls=0`, `fakeCredits="synthetic zero"`, four downloaded camera IDs, repeated ACK ID, purged job, absent objects, and a retained output directory. The `Bearer owner` Storage REST URL in this command is an emulator-only signing/TLS substitute; it is not used in cloud verification.

For emulator rehearsal, run the Functions, Firestore, and Storage emulators and seed the fixture. The verifier gets the production service's callable response DTO with a test-only emulator signer because emulator signing/TLS is not production-equivalent; its ACK still uses the public Functions callable. The cloud verifier uses both public callables and real signed HTTPS URLs. ACK/purge is destructive for the four emulator objects and requires the flag:

```sh
FIREBASE_STORAGE_BUCKET=demo-halloween-tv.appspot.com firebase --config ../firebase.json emulators:exec --project demo-halloween-tv --only functions,firestore,storage \
  "npm run seed:pilot:apply -- --bucket=demo-halloween-tv.appspot.com --party=pilot --device=tv-pilot --channel=haunted_surveillance && npm run verify:delivery -- --target=emulator --bucket=demo-halloween-tv.appspot.com --party=pilot --device=tv-pilot --channel=haunted_surveillance --ack-and-purge --emulator-service-substitute"
```

Expected evidence: four URL DTO entries; independently checked bytes and playable streams; retained files at `backend/functions/delivery-output/...`; two identical ACK IDs; matching Firestore ACK/job state; and no delivery objects. The tool checks the callable response hash against the stored canonical manifest. For a real Firebase project, omit all emulator variables and use explicit `--target=cloud --project=... --bucket=... --functions-url=...`; the cloud path uses actual signed HTTPS URLs and must be run only under a separately approved pilot.

## 10. Verify TTL and orphan cleanup

The emulator suite includes a due job, expired media, and an orphan object and verifies the real retention service deletes all three. Run it serially:

```sh
npm run test:emulator
```

For a deployed project, verify Scheduler has the `sweepExpiredMedia` job enabled and inspect a recent successful invocation before concluding TTL is active:

```sh
gcloud scheduler jobs list --location "$REGION" --project "$PROJECT_ID" --format='table(name,state,schedule,lastAttemptTime)'
gcloud logging read 'resource.type="cloud_scheduler_job" AND resource.labels.location="us-central1"' \
  --project "$PROJECT_ID" --limit=20 --format='table(timestamp,severity,textPayload)'
gcloud storage ls -l "gs://$BUCKET/parties/<PILOT_PARTY>/channels/haunted_surveillance/delivery/"
```

Expected evidence: a successful scheduled sweep in logs; expired jobs transition to `expired`; expired objects and objects not referenced by an unexpired manifest/job are absent. A returned signed URL is time-limited (default 900 seconds) and is not proof that retention has run. Real Firebase URL signing/TLS must be verified in the Firebase project; emulator owner-token downloads are explicitly not equivalent.

## 11. Read-only usage reconciliation and live-credit procedure

Read-only reconciliation checks required per-camera cost fields, task IDs, success outcomes, and uncertain submission states. Missing credit values are labelled `unknown`; fake-provider zero values are labelled `synthetic_zero`:

```sh
firebase --config ../firebase.json emulators:exec --project demo-halloween-tv --only firestore,storage \
  "FIREBASE_STORAGE_BUCKET=demo-halloween-tv.appspot.com npm run usage:reconcile -- --target=emulator"
npm run usage:reconcile -- --target=cloud --project="$PROJECT_ID"
```

Expected evidence: `issueCount=0` for the pilot and four matching camera/task rows. A numeric credit field is not, by itself, proof of a realized provider charge.

After a separate owner-approved live Alibaba batch only, the owner must compare each durable camera `provider_task_id` with the Alibaba console's final per-task usage, capture the console evidence/time and approval reference in the internal change record, and then record the realized `credits_charged` value on the matching per-camera `parties/<party>/costLogs/<job>_<camera>` rows using the approved operator workflow. Re-run read-only reconciliation and attach the before/after output to the record. Do not estimate missing credits, modify provider task IDs/success outcomes, expose evidence in public documents, submit a generation from this runbook, or call synthetic zero a real measurement.

## 12. TV configuration and rollback to offline playback

When the TV composition is wired for live delivery, explicitly set and record all of the following for the intended release: Firebase project ID, Functions region/endpoint (`us-central1`), registered `partyId`, registered `deviceId`, channel `haunted_surveillance`, live manifest source, signed-URL delivery client, verified local cache, ACK only after durable hash verification, and bundled fixture fallback. Confirm the live setting is opt-in and that missing config/network/auth/manifest/download failures select the cached or bundled offline wall.

In this checkout the TV app entry point still instantiates the offline asset boot and no supported live-mode define is consumed. Do not claim live playback from a successful backend callable rehearsal. Once the owner lands the TV composition, record the effective non-secret settings and APK hash, then validate on the target Android TV: four tiles start, audio is muted, hash/size checks pass, the wall returns after a forced network loss, and local cached/offline playback survives backend object purge.

Rollback is a release action to the known offline APK; it does not need a backend write. Keep the offline APK and its SHA-256 with the deployment record:

```sh
sha256sum <OFFLINE_APK>
adb install -r <OFFLINE_APK>
adb shell am force-stop com.joaquinmx.tv_app
adb shell monkey -p com.joaquinmx.tv_app 1
```

Expected evidence: installed package version/hash matches the retained offline artifact; all four bundled feeds play without backend connectivity; no live delivery requests are required. If a remote live-mode switch is later added, set it off before installing the offline artifact and verify the effective setting on the TV.

## 13. Rollback of backend resources

If backend deployment fails after an approved rollout, stop new pilot requests, disable the live TV selection and return devices to the offline APK, then roll back Functions to the recorded prior release. Keep Storage rules deny-by-default and preserve audit/usage records. Do not delete current media or manifests as an ad hoc rollback; use the owner-approved retention/recovery process.

```sh
git worktree add /tmp/halloween-tv-rollback <PREVIOUS_DEPLOYED_COMMIT>
cd /tmp/halloween-tv-rollback/backend/functions
npm ci --force
export GCLOUD_PROJECT="$PROJECT_ID"
export FIREBASE_STORAGE_BUCKET="$BUCKET"
npm run predeploy
cd ..
firebase --config firebase.json deploy --project "$PROJECT_ID" --only functions
firebase --config firebase.json functions:list --project "$PROJECT_ID"
```

Use the approved release pipeline and the exact previously deployed commit/artifact, not an arbitrary branch. Verify the prior release ID, function health, task/scheduler state, rules/index state, and TV offline playback. Do not remove lifecycle policy or loosen security rules during rollback.
