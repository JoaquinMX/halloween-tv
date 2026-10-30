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
| `requestGuestUpload` | callable | party/device-scoped guest |
| `completeGuestUpload` | callable | party/device-scoped guest |
| `getGuestMediaStatus` | callable | party/device-scoped guest |
| `withdrawGuestMedia` | callable | party/device-scoped guest |

Guest ingest objects live under
`parties/{partyId}/guests/{deviceId}/ingest/{submissionId}/photo.jpg` with
server-generated `submissionId` values only; caller-supplied paths and any
cross-party/cross-device/channel substitution are rejected with `FORBIDDEN`.
Firestore guest consent/media docs are callable-only (explicit deny in
`firestore.rules`); Storage guest objects are callable-only (explicit deny in
`storage.rules`, signed URLs bypass rules with backend validation).

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

## QR join (PIN-gated self-registration)

Anonymous by default: no Firebase Auth, no names, no emails. The TV renders a
session QR; the companion scans it (or pastes the same JSON) and self-registers
through the `joinParty` callable, which writes the guest device doc with the
Admin SDK. Direct client device writes stay denied by `firestore.rules`.

- Session QR JSON (TV display, companion parse): an object with EXACTLY these
  keys: `{ "partyId": string, "channelId": string }` plus OPTIONAL
  `"joinPin"`: exactly six ASCII digits as a string (leading zeros significant,
  e.g. `"004201"`). NEVER a deviceId, URL, or secret. Extra keys in
  scanned/pasted input are ignored. The `joinPin` is intentionally carried in
  the QR: it is a displayed shared admission value, not a secret, and the TV
  screen is the disclosure boundary (anyone who can see the TV can read it).
- Authorized set: a device admitted through `joinParty` becomes a full
  party-scoped caller — it may read the current manifest, mint delivery URLs,
  request generation, and ACK/purge deliveries. That breadth is the
  owner-accepted consequence of anonymous admission for a co-located party
  (whoever is in the room and reads the TV screen can join). The residual
  risk of an unbounded admitted set is tracked as an open owner question:
  per-party rate limiting/lockout and per-party guest caps/bounded
  listing/operator removal are explicitly deferred pending owner protocol
  decisions, not implemented controls.
- `joinParty { partyId, deviceId, channelId, joinPin? }` →
  `{ partyId, deviceId, channelId, role: "guest", status: "active", created }`.
  `deviceId` is the phone-generated installation ID (below). `created` is true
  on first registration and false on rejoin; rejoin never rewrites the stored
  doc. The PIN is never echoed in the response.
- `joinParty` failures use `BackendError` codes (same callable `details`
  mapping as above): `FORBIDDEN` (unknown/inactive party, channel
  mismatch/inactive, wrong/missing PIN when configured, deviceId colliding
  with a tv-role or mismatched doc), `UNAUTHENTICATED` (missing
  party/device), `INVALID_ARGUMENT` (malformed ids or PIN shape).
- `listPartyDevices` (TV-only caller, unchanged gate `device.role === "tv"`;
  guests get `FORBIDDEN`) response gains OPTIONAL `"joinPin"` (string when a
  PIN is configured, absent otherwise). Device entries are
  `{ deviceId, label?, role, status }`; `label` may be absent or empty for
  self-registered guests — readers must fall back to a neutral device-based
  display, never duplicate the id as label+value, never prompt for names.
  Device `label` is reserved for later: omit it on create, tolerate
  absent/empty on read, never require it.
- PIN provisioning: `backend/functions/tools/seed_join.ts` merges `joinPin`
  onto the existing party doc after validating the ACTIVE party, channel
  (`== activeChannelId`), and TV registration. Explicit `--join-pin=NNNNNN`
  (six digits, leading zeros preserved); preview by default, `--apply` for
  writes; repeated identical provisioning is idempotent, omitting `--join-pin`
  leaves an existing PIN untouched. Creates NO guest devices, collects NO
  labels, uploads NO media, calls NO providers. Target guards mirror
  `seed_guests.ts` (`--target=emulator|cloud`, explicit `--project` for cloud,
  operator ADC, no service-account keys). Emulator trigger discovery for the
  `demo-halloween-tv` project is driven by the `.env.demo-halloween-tv` file
  (selects the demo project for local emulator runs; carries no secrets).
- Phone installation-ID lifetime (companion): `"p-"` + 32 lowercase hex chars
  from 128 bits of `Random.secure` entropy, persisted under one app-wide
  `SharedPreferences` key and reused across launches, retries, leave, and
  party changes. Corrupt stored values are replaced and re-persisted;
  persistence/entropy failure surfaces retry and never proceeds unpersisted.
  Reinstall/cleared data mints a new installation id and therefore a new
  guest row on next join; the old row remains until operator removal
  (removal tooling is an open owner question, explicitly deferred below).
- Camera deferral (companion): no camera/scanner implementation ships; the
  scan seam returns unavailable, and no camera permission is
  declared/requested. Paste remains available without camera access. Future
  work needs a permission plus validation pass before any scanning ships.
- Migration away from typed guest codes: new parties use QR + PIN
  self-registration. The typed-code path (`tools/guest_codes.ts`,
  `tools/seed_guests.ts`, verbal dictation via `listPartyDevices`) is
  unchanged and stays working — pre-seeded legacy guests (labelled device
  docs) still read the current manifest via `getCurrentManifest` — but the
  updated companion no longer prompts for typed codes.

## Guest upload, consent, and withdrawal

Anonymous registered-device bearer model: no Firebase Auth, no login, no
display name. The same party/device/channel registration gate authorizes every
guest callable.

- `requestGuestUpload { partyId, deviceId, channelId, consent: { accepted: true, textVersion: "v1", purpose: "guest_cameo" }, contentType: "image/jpeg"|"image/png" }`
  records affirmative consent server-side (consent-text version, purpose,
  timestamps, device binding, `pending_upload` status, 15-minute expiry) BEFORE
  issuing a narrowly scoped short-lived signed PUT capability bound to the
  server-generated object path and the content type. The capability is returned
  and never persisted in Firestore or logs.
- `completeGuestUpload { partyId, deviceId, channelId, submissionId }` verifies
  the actual image bytes (JPEG/PNG magic, size within 10 MB), SHA-256, object
  ownership, consent, and expiry before marking the submission `eligible` with
  an immutable source hash/generation and consent revision. Repeats are
  idempotent. Non-image bytes are rejected and never become eligible.
- `getGuestMediaStatus { partyId, deviceId, channelId, submissionId }` returns
  status and consent revision for the owning device only. Signed URLs are never
  included.
- `withdrawGuestMedia { partyId, deviceId, channelId, submissionId }` revokes
  eligibility first (blocking new submissions and publication), deletes the
  source plus attributable remaining cloud derivatives, verifies absence with
  retried deletes, and retains a minimal tombstone. A PUT after withdrawal
  never restores eligibility and is deleted by the `onGuestIngestFinalized`
  cleanup handler. Pending uploads are protected from the orphan sweep;
  abandoned/expired inputs are removed within the capped 24h input TTL.
- `onGuestIngestFinalized` (storage trigger) deletes ingest objects with no
  consent record, a mismatched device binding, or a withdrawn/expired status,
  and leaves pending/eligible objects untouched.

## Consent-bound generation

- `requestGeneration` accepts an optional `guestMediaId` bound to an eligible
  guest submission (same party/device/channel, live consent, unexpired). The
  binding (submission ID, immutable source hash, consent revision) is stored on
  the job and rechecked at request time, at worker submission time, and
  transactionally at publication. Withdrawal fails the bound job closed,
  discards already-running results, and cleans staged bytes.
- Guest execution plan: exactly ONE provider-generated camera slot (`CAM-01`,
  carrying the validated `referenceImage` binding) plus three locally prepared
  fixture slots (`CAM-02`–`CAM-04`). The four-camera manifest contract is kept
  with truthful provenance: fixture slots record `fixture: true` with a null
  provider task ID and null charge; they are never given fabricated provider
  task IDs or charges. The single provider usage row keeps the synthetic zero
  of the offline fake, explicitly not a measured charge.
- Cheap-demo limits are unchanged (`wan3.0-video`, 480p, 2s, silent, 1
  output); text-only behavior is preserved. The Alibaba adapter maps a present
  `referenceImage` to a `reference_image { storage_ref, sha256 }` input via the
  pure offline-tested `buildAlibabaSubmitBody` serializer.
- Provider selection is explicit: a packaged `fixtureDirectory` never silently
  forces fake mode over another configured provider. Fake selection consumes
  the packaged directory; Alibaba selection resolves lazily so discovery and
  local tests never require provider credentials.

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
fixtures; they make no provider network calls. The emulator signing
substitutes (deterministic capability strings) are not equivalent to cloud v4
signed URLs / IAM signing; they only prove per-submission scoping without
persistence. Keep generation disabled during
module discovery and normal local development. A deliberate runtime opt-in is
`GENERATION_ENABLED=true`; selecting the fake provider with
`VIDEO_GENERATION_PROVIDER=fake` remains offline. Deployment and provider
credential setup are outside this contract change.

## Tests

`contracts.test.ts` (payload validation + in-flight/idempotency/error paths),
`backend_contract_fixture.test.ts` (shared JSON fixture through parsing, hashing,
callable service paths, delivery, and ACK), `runtime.test.ts` (disabled default,
queue failure, and fake four-camera generation through handler composition),
`security_rules.test.ts` (party/device-scoped registration reads, denied client
registration writes, denied device listing and party/PIN reads, denied manifest
reads), `seed_join.test.ts` (PIN provisioning preview/apply/idempotency/omit and
refusal paths against the emulator), `qr_join_e2e.test.ts` (PIN-gated join,
rejoin, TV listing, and legacy manifest read through the real exported Functions
emulator endpoints with no auth), `delivery.test.ts` (URL scoping, manifest callable, ACK hash
checks, bounded retry purge), and `retention.test.ts` (TTL transitions, orphan
sweeper). Guest flows are covered by `guest_upload.test.ts` (consent refusal,
completion, scoping, withdrawal, deletion retry, TTL/orphan protection,
generation refusal), `guest_upload_e2e.test.ts` (real-bytes endpoint lifecycle),
`guest_media_generation.test.ts` (one provider camera plus three fixture slots,
truthful usage, withdrawal races), and `alibaba.test.ts` (offline guest-image
serialization fixture, zero network). Emulator-backed cases skip when `FIRESTORE_EMULATOR_HOST` is unset;
run `npm run test:emulator` (project `demo-halloween-tv`) for the full suite.
