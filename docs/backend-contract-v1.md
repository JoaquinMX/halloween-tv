# Backend contract v1 (Halloween TV)

Source of truth for callable payloads is `backend/functions/src/contracts.ts`;
endpoint composition lives in `backend/functions/src/index.ts`. This document
summarizes the wire contract for TV / owner clients. Machine-readable shapes:
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

## Services (7)

| Service | Trigger | Caller |
|---|---|---|
| `requestGeneration` | callable | party/device-scoped |
| `runGeneration` | task queue `runGeneration` | worker only (`maxAttempts: 1`, `maxConcurrentDispatches: 1`) |
| `normalizeAndStage` | internal (worker composition) | never an HTTP endpoint |
| `publishManifest` | internal (worker composition) | never an HTTP endpoint |
| `getDeliveryUrls` | callable | party/device-scoped TV |
| `acknowledgeDelivery` | callable | party/device-scoped TV |
| `sweepExpiredMedia` | schedule `every 15 minutes` | runtime |

Firestore layout: `parties/{partyId}` (`ownerUid`, `status`, `activeChannelId`),
`channels/{channelId}`, `manifests/current_{channelId}` (`version`,
`cameraClips[4]`, `schemaVersion`), `jobs/{jobId}` (state machine
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
  with `INVALID_ARGUMENT`. Same `(jobId, idempotencyKey, deviceId, channelId)`
  returns the existing job (`created: false`); reused `jobId` with different
  binding → `FORBIDDEN`.
- `getDeliveryUrls { partyId, deviceId, channelId }` →
  `{ manifestVersion, manifestHash, clips[] }` with v4 signed read URLs capped
  at the clip's own `expiresAt`. Expired manifest/clip → `CLIP_EXPIRED`.
- `acknowledgeDelivery { partyId, deviceId, channelId, manifestVersion, clipHashes }`
  — `clipHashes` must carry exactly the 4 canonical SHA-256 hashes and match
  the current manifest, else `MANIFEST_MISMATCH`. Idempotent on
  `(deviceId, channelId, manifestVersion)`; ACK moves the job
  `ready/delivering → delivering` then purges delivery objects and marks it
  `purged`. Repeat ACKs return the same `ackId`.

## Budget guards

- Max 1 generation in flight per party (`BUDGET_EXCEEDED` otherwise).
- Zero automatic retries on billable calls: the task queue uses
  `maxAttempts: 1`; each batch needs an explicit owner action
  (`requestGeneration`).
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

## Tests

`contracts.test.ts` (payload validation + in-flight/idempotency/error paths),
`security_rules.test.ts` (party/device-scoped reads, deny unregistered callers
and all client writes), `delivery.test.ts` (URL scoping, ACK vs canonical
hashes, purge after ACK), `retention.test.ts` (TTL transitions, orphan
sweeper). Emulator-backed cases skip when `FIRESTORE_EMULATOR_HOST` is unset;
run `npm run test:emulator` (project `demo-halloween-tv`) for the full suite.
