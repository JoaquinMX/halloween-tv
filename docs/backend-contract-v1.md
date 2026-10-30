# Backend contract v1 (Halloween TV)

Source of truth for callable payloads is `backend/functions/src/contracts.ts`;
exported handler composition lives in `backend/functions/src/index.ts` and
`backend/functions/src/runtime.ts`. This document summarizes the wire contract
for the existing TV. Machine-readable request and response examples:
`test/fixtures/backend_contract_v1.json`.

## Identity (binding rule)

Requests are anonymous by default. No Firebase Auth uid, no email, no login
gates on TV or generation interfaces. Every callable takes `partyId` +
`deviceId` (+ `channelId`) and the server accepts them only when they match a
**registered** party/device pair (`parties/{partyId}` with `status: active`,
`parties/{partyId}/devices/{deviceId}` with `status: active` and matching
`partyId`, plus an active channel equal to the party's `activeChannelId`).
Unregistered ids → `FORBIDDEN`. Every job doc, job status and cost-log entry
records `partyId`, `deviceId`/`channelId`, `manifestVersion`, `timestamp` and
an idempotency key.

## Services (8)

| Service | Trigger | Caller |
|---|---|---|
| `requestGeneration` | callable | party/device-scoped |
| `runGeneration` | task queue `runGeneration` | worker only (`maxAttempts: 1`, `maxConcurrentDispatches: 1`) |
| `normalizeAndStage` | internal (worker composition) | never an HTTP endpoint |
| `publishManifest` | internal (worker composition) | never an HTTP endpoint |
| `getCurrentManifest` | callable | party/device-scoped TV |
| `getDeliveryUrls` | callable | party/device-scoped TV |
| `acknowledgeDelivery` | callable | party/device-scoped TV |
| `sweepExpiredMedia` | schedule `every 15 minutes` | runtime |

Firestore layout: `parties/{partyId}` (`ownerUid`, `status`, `activeChannelId`),
`channels/{channelId}`, `manifests/current_{channelId}` (`version`,
`cameraClips[4]`, `schemaVersion`, stable publication `createdAt`),
`jobs/{jobId}` (state machine
`queued → running → ready → delivering → purged`, plus `failed`/`expired` with
sanitized `errorCode`, `modelId`, `costEstimate`), `devices/{deviceId}`,
`deliveryAcks/{ackId}`.

Storage layout: `parties/{partyId}/channels/{channelId}/delivery/{version}/{camera}.mp4`
(served only via short-lived signed URLs minted after callable checks; rules
deny all direct client reads/writes). `ingest/` and `generated/{jobId}/`
prefixes are worker-internal. Lifecycle TTL (`storage.lifecycle.json`,
`daysSinceCustomTime: 1` on `parties/`) is defense-in-depth behind
`sweepExpiredMedia`.

## Payloads

- `requestGeneration { partyId, deviceId, channelId, jobId, idempotencyKey, presetId }`
  — `presetId` must be `"cheap_demo"`; any other model/preset field is rejected
  with `INVALID_ARGUMENT`. The callable returns `{ jobId, state, created }`.
  Same `(jobId, idempotencyKey, deviceId, channelId)` returns the existing job
  (`created: false`) without enqueueing another task; reused `jobId` with
  different binding → `FORBIDDEN`.
- `getCurrentManifest { partyId, deviceId, channelId }` → the validated current
  manifest as plain JSON, including four camera-keyed clips and a stable ISO
  `createdAt` publication timestamp. It does not grant direct Firestore access;
  client reads of `manifests/` remain denied by rules.
- `getDeliveryUrls { partyId, deviceId, channelId }` →
  `{ manifestVersion, manifestHash, clips[] }` with v4 signed read URLs capped
  at the clip's own `expiresAt`. Both manifest and URL calls return only the
  current version for the requested active channel. Older delivery versions
  are never signed. Expired manifest/clip → `CLIP_EXPIRED`.
- `acknowledgeDelivery { partyId, deviceId, channelId, manifestVersion, clipHashes }`
  — `clipHashes` is a map keyed by camera ID (`CAM-01` through `CAM-04`) and
  must carry exactly one canonical SHA-256 hash per camera. A first ACK must
  match the unexpired current manifest, else `MANIFEST_MISMATCH` or
  `CLIP_EXPIRED`. The accepted ACK stores the job ID and its four validated
  version-scoped object paths and hashes. Repeats revalidate registration and
  hashes, return the same `ackId`, and retry only those stored paths even after
  expiry or a newer manifest publication. A conflicting hash is rejected;
  objects belonging to a newer version are never purged by an older ACK.

## Budget guards

- Max 1 generation in flight per party (`BUDGET_EXCEEDED` otherwise).
- Zero automatic retries on billable calls: the task queue uses
  `maxAttempts: 1` and one concurrent dispatch; each batch needs an explicit owner action
  (`requestGeneration`).
- Generation is disabled unless `GENERATION_ENABLED=true` is explicitly set.
  The runtime uses the same generation-store/provider composition in exported
  handlers and emulator tests. Queue failure marks a still-queued job failed
  and releases its party budget. The fake provider is offline; Alibaba provider
  construction is lazy and is not needed for module discovery or local tests.
- Cost log fields: `model_id, preset_id, seconds_out, seconds_in,
  credits_charged, provider_task_id, created_at, success` plus
  `partyId/deviceId/channelId/manifestVersion/timestamp/idempotencyKey`.
- Preset lock: `cheap_demo` only — `wan3.0-video, singapore, 480P, 2s, 16:9,
  no audio, 1 output, no auto-upscale`. Contracts reject anything else; p4
  enforces provider-side.

## Credentials

Never in the Flutter app, manifest, public Firestore docs, or `.env.example`
(placeholders only). Provider keys live server-side (Cloud Secret Manager /
Functions config). No billable generation call is executed in p1; emulator
seeding uses `backend/functions/tools/seed_pilot.ts` with fixture bytes.

## Error codes

`UNAUTHENTICATED` (missing party/device) · `FORBIDDEN` (unregistered/inactive
party-device-channel or idempotency mismatch) · `MANIFEST_MISMATCH` ·
`CLIP_EXPIRED` · `PROVIDER_UNAVAILABLE` · `BUDGET_EXCEEDED` ·
`INVALID_ARGUMENT` · `NOT_FOUND` · `INTERNAL`.

Callable failures use Firebase `HttpsError` codes with `details: { errorCode }`.
The detail preserves the backend code above; Firebase codes are respectively
`unauthenticated`, `permission-denied`, `failed-precondition`,
`failed-precondition`, `unavailable`, `resource-exhausted`, `invalid-argument`,
`not-found`, and `internal`.

## Local verification and operator switch

From `backend/functions`, `npm run build` checks the TypeScript deployment
composition. `npm run test:emulator` runs Firestore and Storage emulator tests
serially. These tests use the deterministic fake provider and repository MP4
fixtures; they make no provider network calls. Keep generation disabled during
module discovery and normal local development. A deliberate runtime opt-in is
`GENERATION_ENABLED=true`; selecting the fake provider with
`VIDEO_GENERATION_PROVIDER=fake` remains offline. Deployment and provider
credential setup are outside this contract change.

## Tests

`contracts.test.ts` (payload validation + in-flight/idempotency/error paths),
`backend_contract_fixture.test.ts` (shared JSON fixture through parsing, hashing,
callable service paths, delivery, and ACK), `runtime.test.ts` (disabled default,
queue failure, and fake four-camera generation through handler composition),
`security_rules.test.ts` (party/device-scoped registration reads and denied
manifest reads), `delivery.test.ts` (URL scoping, manifest callable, ACK hash
checks, bounded retry purge), and `retention.test.ts` (TTL transitions, orphan
sweeper). Emulator-backed cases skip when `FIRESTORE_EMULATOR_HOST` is unset;
run `npm run test:emulator` (project `demo-halloween-tv`) for the full suite.
