# Cycle 13 catalog pipeline runbook

Current status (2026-10-31): the authorized live rollout is closed; two cartoon clips were delivered and ACKed. Generation is now disabled/fake, the queue is empty, and host-invite TTL/index are active. Phone host pairing, both retained CAM-01 previews, and guest consent UI are now physically verified after two companion fixes (168/168 independent tests; analysis clean). TV v3 cached playback is recovered: CAM-01 shows the cartoon; CAM-02/04 play near-black local fixtures and CAM-03 plays its bars fixture, as planned for the single-generated-camera batch. A four-cartoon wall was not generated. See [TV recovery acceptance](cycle13/verification-95b501b-tv-recovery.json). See [phone acceptance](cycle13/verification-5e3423d-phone.json) and the final independent rollout acceptance [verification-f6cde52.json](cycle13/verification-f6cde52.json). Earlier offline verification below is historical, not a description of the post-rollout cloud state.

## Scope and safety

This runbook covers the backend-owned cartoon pipeline on Alibaba Singapore Token Plan only: `qwen-image-3.0-pro` for stills (synchronous multimodal generation, in-process data URIs, no task polling) and `wan3.0-video` STANDARD for video (first_frame carried as an in-process data URI inside `input.media`, never hosted bytes). Video controls remain 2 seconds, 480P, silent, no watermark, and `prompt_extend=false`. The `cheap_demo` and `cameo_demo` preset locks remain unchanged. Do not use Google, Veo, or Imagen. The batch planner is preview-only; no live provider request, cloud migration, or deployment is part of preparation.

Owner UX: the guest does consent + upload only — no prompt, scene, or situation UI exists anywhere on the guest path, and the client must not supply a plan. The server randomly selects the catalog scenario + compatible situation at job setup (seeded RNG, versions/seed persisted immutably in the cartoon plan at creation; retries reuse, never reroll). Eligible-upload completion and ingest-finalization/replay races idempotently enqueue the backend-selected two-stage generation when generation is enabled, under the existing consent/budget guards: one persisted plan, one job, one enqueue, no reroll/rebill. Generation-disabled keeps upload fully operational.

## Gates and execution order

1. Review the 3-case preview with the owner. Each case needs an authorized portrait submission and the separately identified scene/style reference. Confirm fixed plan IDs, versions, seeds, model pins, and 9 fixture slots.
2. Verify a demonstrably unused, still-applicable owner-approved Token Plan Credit allowance, or obtain a concrete final ceiling if no such allowance can be established. This workstream does not reset earlier 3-video/5-attempt allowances. Record still-stage and video-stage budget inputs separately; do not estimate realized prices. Credits stay UNKNOWN (null) until the provider reports actual charges. Do not submit if the applicable remaining allowance cannot be established.
3. Run `npm run build`, `npm test`, and the emulator suite including `cartoon_delivery_e2e.test.ts`. The emulator test must exercise actual stored media bytes, normalized H.264/yuv420p/24fps/854x480 two-second media, four downloads, independent hashes, ACK/purge, preview retention, and withdrawal denial. Any emulator signing substitution must be named explicitly and is not production-equivalent.
4. Run `npm run runtime:prepare`, then the offline packaging preflight. Inspect generated artifacts and confirm no credentials, private photos, or signed URLs are included.
5. Before any separately authorized live batch, capture the approved exact scope (3 stills + 3 videos, 6 generated seconds, fixture slots, budget ceiling, consented portrait IDs), operator, date, and rollback owner. Reconcile provider task IDs and actual console Credit usage per stage after each submission; stop on a ceiling breach or any unrecognized charge.

Prepare the preview with `npm run cartoon:prepare -- --party=<id> --device=<id> --channel=<id> --max-credits=<owner-value>`. This command only prints a proposal; it cannot submit live work or write cloud data. Keep private portrait bytes in the authorized ingest path and out of review documents.

## Publication and delivery

Publication requires completed still and video stages and matching still-stage hash provenance. Offline-fake stills are marked `fixture:true` and publication refuses them for non-rehearsal jobs. Authorization is re-evaluated during publication replay and immediately before delivery URLs are issued. Guest consent is scoped to its submission, source hash, revision, and expiry. Explicitly approved legacy/operator/host seeds may be delivered without manufacturing mobile consent. Withdrawal, expiry, deletion, changed source, unknown binding, unreadable authorization records, and unauthorized bindings fail closed with stage-specific diagnostics.

The canonical manifest hash, 1/2/4-camera contracts, MIME/profile validation, idempotent ACK, and purge semantics remain required. Signed URLs are in-flight only and must never be persisted. Diagnose failures separately as manifest, authorization, signing, download, hash, or ACK. Reproduce the legacy-seed case through `createRuntimeServices`, `getCurrentManifest`, `getDeliveryUrls`, downloaded object bytes, independent SHA-256, then ACK and purge. A successful URL response alone is not a successful delivery.

## Reference provenance (factual note)

The 16 reference stills shipped under `assets/scenario_refs/` (one per catalog record, sha256/sizeBytes pinned in `scenario_catalog.v1.json`) are the style references for the `qwen-image-3.0-pro` still stage; the batch preview re-verifies each referenced file against its pinned hash before emitting a row. The supplied refs are task-authorized inputs. The original catalog preparation was offline only (no live provider calls); the subsequent separately authorized live rollout is recorded below. The preview requires a numeric ceiling argument, which is an offline constraint, not approval to spend; establish the owner's applicable remaining allowance before any live submission. Preparation never submits live work or writes cloud data; prompt composition stays server-owned (the client never supplies prompts, scenes, or plans).

## Few-case preview (verbatim, 3 cases)

The following 3 cases are the exact output of `npm run cartoon:prepare -- --party=pilot --device=tv-pilot --channel=main --max-credits=10` (prompts byte-identical to the server composer; still-to-video role ordering preserved: the generated still becomes the video `first_frame`; the still stage takes subject_identity + style_scene). The value `10` is an offline example, not an approved Credit budget or measured spend.

### Case 1 — storybook-kitchen / kitchen-slapstick-chase (selection seed `cartoon-batch-case-1`)
- Scenario: `storybook-kitchen` version 1. Situation: `kitchen-slapstick-chase` version 1.
- Selection seed: `cartoon-batch-case-1`.
- Reference paths: `test/fixtures/guest_photo.jpg` (subject_identity byte-shape stand-in only; real batches use consented ingest portraits) and `assets/scenario_refs/5c0e9bf8-864a-4146-b2f7-4e04f5c2520e.JPG` (style_scene, sha256 `fd6a42315e77ea8992ce255a1bae6a97a5317e4c98bd0860204403d7780ea9b1`, 811504 bytes).
- Still: `cartoon-still-plan-04` version 1 seed 130103, `qwen-image-3.0-pro` (singapore). Video: `cartoon-video-plan-04`, `wan3.0-video` STANDARD 2s/480P/silent.
- Still prompt:
```
Subject and identity: use the subject_identity reference as the character identity. Redraw the person in the subject_identity reference (the uploaded subject) as a coherent, fully illustrated cartoon character; preserve the subject's actual distinctive attributes (glasses, facial hair, hairstyle, outfit) exactly as seen in the subject_identity reference, without photographic skin or pasted photographic details.
Reference roles: reference image 1 is the SCENE/STYLE reference only (its pre-existing characters, if any, must NOT appear — setting and palette only); reference image 2 is the ACTUAL PERSON (uploaded subject identity), who must be visually dominant in the foreground; redraw that person fully illustrated preserving their actual distinctive attributes.
Static opening tableau: the uploaded subject stands center-foreground beside a tipped pot and the cauldron/stew tub, pot lids arranged as set dressing nearby with a flour/steam puff prop in place, the goofy kitchen monster stationed a step behind; hearth and stone-arch kitchen frames the pair; all figures and props hold completely still with sharp static clarity.
Scene and style: Bustling storybook kitchen with hearth cauldron and stone arches, empty of pre-existing characters Chowder Marzipan-City cartoon kitchen, wobbly hand-inked lines, textured ochre/magenta washes, squishy round shapes Constraints: Kitchen chase: slip on pots, hide behind cauldron; food gags only Kitchens only; steam and pot lids as cover; food gags only
Cast: empty of pre-existing characters; the only figures are the uploaded subject (foreground, visually dominant) and one goofy kitchen monster by the cauldron.
```
- Video prompt:
```
Animate the supplied illustrated first frame. 0-1s: guest slips on a tipped pot and skids across the kitchen floor as the monster gives chase. 1-2s: guest ducks behind the cauldron/stew tub while pot lids spin through the air as cover. 2s: a harmless flour/steam puff whites out the frame and both dash offscreen. Food and steam gags only; no burns, no gore. Preserve the illustrated character identity and scene.
```

### Case 2 — halloween-graveyard / horde-swarm-chase (selection seed `cartoon-batch-case-2`)
- Scenario: `halloween-graveyard` version 1. Situation: `horde-swarm-chase` version 1.
- Selection seed: `cartoon-batch-case-2`.
- Reference paths: `test/fixtures/guest_photo.jpg` (subject_identity byte-shape stand-in only; real batches use consented ingest portraits) and `assets/scenario_refs/96cf7a63-7d8e-485e-a7cc-9e6654b920e6.JPG` (style_scene, sha256 `c6defa106f8d331e3f9aca21f39571ba16aba4d83bcffd15b6ec4295e9d5da35`, 175224 bytes).
- Still: `cartoon-still-plan-07` version 1 seed 130106, `qwen-image-3.0-pro` (singapore). Video: `cartoon-video-plan-07`, `wan3.0-video` STANDARD 2s/480P/silent.
- Still prompt:
```
Subject and identity: use the subject_identity reference as the character identity. Redraw the person in the subject_identity reference (the uploaded subject) as a coherent, fully illustrated cartoon character; preserve the subject's actual distinctive attributes (glasses, facial hair, hairstyle, outfit) exactly as seen in the subject_identity reference, without photographic skin or pasted photographic details.
Reference roles: reference image 1 is the SCENE/STYLE reference only (its pre-existing characters, if any, must NOT appear — setting and palette only); reference image 2 is the ACTUAL PERSON (uploaded subject identity), who must be visually dominant in the foreground; redraw that person fully illustrated preserving their actual distinctive attributes.
Static opening tableau: the uploaded subject stands center-foreground on the road/path in a calm poised stance, the goofy pumpkin mob with the monster among them stationed along both sides with scattered candy and harmless props; night/dusk outdoor set with graves and fields frames the group; all figures hold completely still with sharp static clarity.
Scene and style: Crowded spooky graveyard at night with glowing jack-o-lantern mound and tombstones Grim-Adventures Halloween cartoon graveyard, sickly green night glow, thick black outlines, flat purple stone Constraints: Outdoor horde chase fits perfectly; monster can join pumpkin mob; keep candy/graves, no gore Outdoor night/dusk chases; monster may join the mob; keep candy/graves/van livery
Cast: empty of pre-existing characters; the only figures are the uploaded subject (foreground, visually dominant) and a goofy pumpkin mob with the monster among them.
```
- Video prompt:
```
Animate the supplied illustrated first frame. 0-1s: guest flees down the road/path as a goofy pumpkin mob (or the chasing monster joining it) pours in from the sides. 1-2s: guest weaves through the crowd, candy/props flying harmlessly, and dives toward the van doorway. 2s: doors slam on the mob; one pumpkin face squishes against the glass. Outdoor night/dusk only; candy and graves stay; no gore. Preserve the illustrated character identity and scene.
```

### Case 3 — farmhouse-sitting-room / couch-gag-chase (selection seed `cartoon-batch-case-3`)
- Scenario: `farmhouse-sitting-room` version 1. Situation: `couch-gag-chase` version 1.
- Selection seed: `cartoon-batch-case-3`.
- Reference paths: `test/fixtures/guest_photo.jpg` (subject_identity byte-shape stand-in only; real batches use consented ingest portraits) and `assets/scenario_refs/IMG_3924.JPG` (style_scene, sha256 `74ce527a8422fa771c7c34d645024e07db1e3291e215b3e2d19c2c14d080101d`, 405004 bytes).
- Still: `cartoon-still-plan-10` version 1 seed 130109, `qwen-image-3.0-pro` (singapore). Video: `cartoon-video-plan-10`, `wan3.0-video` STANDARD 2s/480P/silent.
- Still prompt:
```
Subject and identity: use the subject_identity reference as the character identity. Redraw the person in the subject_identity reference (the uploaded subject) as a coherent, fully illustrated cartoon character; preserve the subject's actual distinctive attributes (glasses, facial hair, hairstyle, outfit) exactly as seen in the subject_identity reference, without photographic skin or pasted photographic details.
Reference roles: reference image 1 is the SCENE/STYLE reference only (its pre-existing characters, if any, must NOT appear — setting and palette only); reference image 2 is the ACTUAL PERSON (uploaded subject identity), who must be visually dominant in the foreground; redraw that person fully illustrated preserving their actual distinctive attributes.
Static opening tableau: the uploaded subject stands center-foreground beside the couch with cushions in place, rug edge and floor lamp nearby and the off TV set in the background, the cartoon monster stationed at the couch end; living-room set frames the pair; all figures and props hold completely still with sharp static clarity.
Scene and style: Quaint farmhouse sitting room with red armchair, rocker, rug and daylight windows Courage-the-Cowardly-Dog farmhouse living room, crunchy ink, dusty rose/red wood, garish green monster accents Constraints: Classic mask-scare beat fits; monster lunges, guest recoils; keep one monster only Domestic living rooms only; furniture wobbles, never breaks; no menace beyond spooky twist
Cast: empty of pre-existing characters; the only figures are the uploaded subject (foreground, visually dominant) and one cartoon monster at the couch end.
```
- Video prompt:
```
Animate the supplied illustrated first frame. 0-1s: guest vaults the couch lengthwise, cushions bouncing, monster close behind. 1-2s: guest trips on the rug edge, grabs a floor lamp that wobbles but never falls, and scrambles up. 2s: both race past the off TV (static flickers once) and out the room doorway. Keep living-room scale; lamp never breaks. Preserve the illustrated character identity and scene.
```
## Host seed path and pending-queue dispatch (fix-5a, factual)

Host `generateHostVideo` is a scoped entry point to the same pipeline, never a parallel one. With a portrait (`guestMediaId`), it builds the backend-selected two-stage cartoon plan through the same deterministic server selector as the guest portrait path (same submission id yields the same scenario/situation/plan IDs/version/seed, persisted immutably), binds the server-written host seed provenance (`{ seedId, kind: "host" }`, registered host device recorded on the seed doc, never derived from a jobId prefix), and enqueues exactly once through the runtime task-queue path (`failEnqueue` on queue admission failure). Without a portrait it keeps the legacy fixed-preset queue. Repeats of the identical seed request reuse the queued job (`created: false`, no second submit); a genuinely different seed while one job is in flight surfaces typed `BUDGET_EXCEEDED`, never a silent wedge. Host-source upload completion does not auto-enqueue: the explicit seed request owns that scope's one job/plan, so the two arrivals cannot consume two jobs or self-block single-flight.

Guest portraits persist a durable pending intent (`parties/{partyId}/pendingGenerations/{submissionId}`, bound to party+submission+consent revision with the immutable plan) in the same transaction as eligibility. When the party is busy, completion stays `eligible` with queue state `pending` and the guest does nothing further. Bounded server dispatch runs after capacity releases (worker settle, consent withdrawal, queue-admission failure handling): exactly one queueing with the same plan (no reroll), single-flight preserved, withdrawal/expiry rechecked at dispatch (withdrawn/expired pending is deleted, never dispatched), existing failed jobs never blindly resubmitted. Unrecoverable queue admission marks the intent `unavailable`, readable via `getGuestMediaStatus` as `generation.state: "unavailable"` (never silent eligible-forever). Billing limits and unknown-outcome handling are unchanged.

## Rollback, retention, and physical TV check

Rollback by stopping new submissions, disabling publication for affected jobs, withdrawing impacted consent or deleting the affected seed through its supported authorization path, and purging only after the owner confirms retention obligations. Retain task/charge reconciliation, manifest hashes, ACK results, and sanitized diagnostic codes according to the applicable party retention policy; do not retain signed URLs or portrait bytes in logs.

Physical-TV observation checklist (historical pre-rollout checklist; current proof and limitations are recorded below):

- Confirm the correct party/channel and all four expected camera tiles.
- Observe startup, playback, reconnect, and refresh behavior; record visible errors and timestamps.
- Confirm that ACK purges delivery object bytes while separately retained host previews remain available.
- Withdraw the portrait consent and verify that a subsequent URL request is denied.
- Record device, build, emulator-signing differences, and operator observations. Emulator validation is not physical-TV validation.

At the pre-rollout code closure, physical smoke, deployment, and live-provider submissions had not yet been performed. The subsequent authorized rollout deployed the backend and produced the TV proof recorded below; physical phone verification remains pending. These earlier boundaries are historical, not a new approval gate or the current cloud state.

## Fix-5d behavior notes (review-E + review-F)

- Rehearsal is server-only: `generateHostVideo` rejects any caller-supplied `rehearsalOnly` (`INVALID_ARGUMENT`); fixture stills publish only when the server-derived `rehearsalOnly` marker is persisted on the job.
- Queue intent lifecycle is transient-vs-terminal: withdrawn/expired/not-found/forbidden delete intents, ambiguous read failures leave the intent pending with attempt accounting, and `unavailable` is reserved for genuine admission/terminal errors (queue rejection, consent/permission denial).
- Withdrawal-triggered flush uses the validated identity's `partyId` from the withdrawal result, never the raw caller value.

## Fix-5e behavior notes (created-gated dispatch; created-only mismatch release)

- Pending-intent dispatch enqueues a queue task ONLY when the store reports the cartoon request as just-created (`created: true`). A reused/raced job (`created: false`) never enqueues here: the flush reads the actual existing job state and reflects it on the intent (queued/running -> intent queued; failed -> intent unavailable with the job's code; ready/delivering/expired/purged -> intent done; missing -> stays pending for the next pass, never deleted).
- On cartoon-plan drift, only the just-created job is failed transactionally via `failEnqueue` (budget released, job + ledger rows preserved with verifiable provenance), then the intent is marked unavailable/`MANIFEST_MISMATCH`. A reused job is never touched on drift (intent-only marking). No path raw-deletes a job or rerolls the stored plan.

## Rollout-6 cartoon definitive-failure coverage (explicit)

- The rollout-5 fail-on-definitive regressions in `generation.test.ts` (4xx-certain submit failure, validation config error, ambiguous timeout) exercise the TEXT path only (`cheap_demo`/`cameo_demo` four-camera run); they do NOT cover the cartoon still/video FAILED paths or the missing-image-config path. Do not cite them as cartoon-path evidence.
- Cartoon-path coverage is explicit and separate, all through the REAL `runGeneration` cartoon request path with fake/stub providers (zero live calls): (a) missing image config fails the claimed job by identity (`CartoonImageProviderMissingError`, generic `PROVIDER_UNAVAILABLE` stays non-definitive) with budget idle and the next request proceeding; (b) definite still FAILED takes the text-path `recordProviderFailure` fail+release (job failed, budget idle, provider reason preserved, failure usage row kept); (c) definite video FAILED takes the same fail+release; (d) ambiguous still/video timeouts keep release-only (job running, lease released, no fail, no resubmit, budget stays in_flight). The narrow classifier unit test pins the identity boundary (same message text as a generic error stays non-definitive).
- Timeouts/unknowns on the cartoon path never resubmit (still/video submit-once guards hold) and never fail; failed cartoon jobs are terminal and are never resubmitted by the worker.

## Rollout-5 live-forensics hardening (bounded fetch timeouts, fail-on-definitive)

- Fetch timeouts: video submit/status/result 30s each; image POST 120s, reference-image fetch 60s. Every provider fetch carries an AbortSignal; a timeout aborts and classifies as certainty `unknown` (never `non_billable`), never success. Unknown-outcome stills are never auto-resubmitted.
- Fail-on-definitive: only validation/consent/4xx-certain errors fail the claimed running job via `failClaimedJob` (state failed + budget idle, job + ledger evidence preserved, never touches unclaimed jobs). Unknown/timeout/ambiguous paths keep `releaseWorker` only.
- Wedged-running recovery: a `running` job with no lease that never settles (terminal config left running by an old worker) is redispatchable via the repo queue client with the same task identity (`partyId/deviceId/channelId/jobId/idempotencyKey`); the claiming worker re-evaluates definitiveness and fails or progresses it. Do not delete the job or hand-roll budget writes.

## Historical verification evidence (pre-rollout code closure)

Task restatement: 16-scenario image-backed catalog, two-stage cartoon pipeline (qwen-image-3.0-pro still -> wan3.0-video STANDARD first_frame), scoped consent provenance, delivery-gap repair, host callable enqueue, pending-intent queue, explicit role mapping + situation tableaus.

Plan pointer: the harness plan produced 4 partitions (p1 catalog/packaging, p2 pipeline/wiring, p3 provenance/migration, p4 contracts/delivery/runbook) plus sequential fixes through fix-5e closing delivery gaps, host dispatch, durable pending intents, server-only rehearsal provenance, concurrent dispatch, and created-only plan-mismatch release.

Independent parent verification on merged source `8fa76936cc8b736c3f09ee2fbfe241c3fa31efc9`: `npm run test:emulator` exited 0, including the TypeScript build and all 215 Firestore + Storage + Functions emulator tests (215 passed, 0 failed, 0 skipped). Both deterministic fix-5e regressions executed. The child also reported 105 unit passes / 110 emulator-gated skips; the independent full-emulator result is the acceptance evidence. Earlier runtime:prepare structural-only and cartoon:prepare 3-case offline preview checks remain applicable because packaging inputs did not change (16 packaged scenarios, 0 live submissions, Credits UNKNOWN). Machine-checkable parent acceptance, closed finding IDs, plan receipt hash, review scope and remaining boundaries: [verification-8fa7693.json](cycle13/verification-8fa7693.json). The immediate pre-rollout closure edits were documentation/evidence only. Later rollout source changes are covered by the final independent acceptance section below.

Coverage distinctions (be precise): (i) real serializer tests against the verified Token Plan shapes (input.messages image+text content, parameters incl. negative_prompt; video input.media first_frame) — no network; (ii) network-mocked adapter tests with fetch stubs asserting zero live calls and request body shapes; (iii) fake-rehearsal two-stage tests using FakeImageGenerationPort/FakeVideoGenerationPort proving pipeline orchestration by construction (cannot prove wire bytes — fake ports substitute for provider wire bytes, so byte-level provider equivalence is not established by these tests); (iv) emulator E2Es on real storage bytes (delivery bytes/hashes/ACK/purge/preview retention/withdrawal denial; host portrait real-path; two-guest busy exactly-once; cartoon chain still-bytes vs hash at publish).

Honest review statement: A/B/C cover the earlier base diff, not the final tree. D approved with no findings; E approved with 2 Low + 1 Minimal findings; F requested changes with 1 High + 5 Low + 1 Minimal findings. All 10 E/F findings were addressed in fix-5d. No fresh three-role review covers fix-5e; the parent independently audits that narrow diff and reruns the full merged-tree emulator suite. Do not describe earlier reviews as approval of the final diff.

Historical boundaries of that pre-rollout audit only: 0 provider calls, credits UNKNOWN, no cloud deploy/migration, no device proof, no main merge. The later live rollout and final acceptance supersede those operational boundaries.

## Rollout closure (live batch + safe window) — appendix

Sanitized only: no private inputs/URLs/credentials/keys, no image bytes/data URIs. Device proof pointers below are sanitized (no pairing codes/QR content).

### 1. Approval record (owner "Run remaining pendings", bounded ceiling)

- Owner directive: "Run remaining pendings" — bounded to the 3 pending cartoon cases only.
- Ceiling: 3 stills + 3 videos maximum (6 generated artifacts). No retries on unknown outcomes. No 4th case.
- Fixed controls: single generated camera + 3 fixture cameras; 2s / 480P / silent / no-watermark; `prompt_extend=false`.
- Provider scope: Alibaba Singapore only (`qwen-image-3.0-pro` stills, `wan3.0-video` STANDARD video).
- Consent/budget guards unchanged: one persisted plan, one job, one enqueue per case; no reroll/rebill; unknown-outcome stills never auto-resubmitted.

### 2. Submission table (all real, live batch)

| Case | Job ID | Scenario / situation | Plan seed | Still submits | Video submits | Evidence |
|------|--------|----------------------|-----------|---------------|---------------|----------|
| 1 | `hv-cartoon-case-1` | pink-mansion-foyer / grand-staircase-chase | 130102 | 1 uncertain still POST counted as spent, zero confirmed submits | 0 | Failed + budget released via `failClaimedJob`; evidence preserved |
| 2 | `hv-cartoon-case-2` | furnace-kitchen-pass / kitchen-slapstick-chase | 130108 | 1 | 1 | Still sha `657d2935…fcee40` (1157339 B); video sha `7091f48a…9203252f` (563257 B, h264/854x480/24fps/2.0s); manifest v2 |
| 3 | `hv-cartoon-case-3` | pink-mansion-foyer / grand-staircase-chase | 130102 | 1 | 1 | Still 847983 B; video sha `dc2d89ac…a9d9` (672987 B, same profile); manifest v3 |

Totals: still POSTs 2 confirmed + 1 uncertain-reserved = 3/3 (ceiling reached, none remaining); videos 2/3 (1 unused, not convertible to a still or a 4th case).

Credits: UNKNOWN everywhere. Ledger rows record null; no realized console charges surfaced during the batch, and no console reconciliation was performed. Do not estimate realized prices.

### 3. Failures / gaps closed live

Each item below was observed live and is now closed in code (see behavior notes above where applicable):

- `image-provider-unconfigured`: missing image config left a job running with no gate. Closed by an `IMAGE_GENERATION_PROVIDER` startup/config gate (missing config fails fast by identity as `CartoonImageProviderMissingError`, never wedges running).
- int32 seed clamp: a failing seed value `3399556814` exceeded int32 range. Closed by clamping/normalizing seed handling on the cartoon path.
- No-timeout POST: provider POSTs without bounded timeouts could hang a worker lease. Closed by bounded fetch timeouts (video submit/status/result 30s each; image POST 120s; reference fetch 60s) with AbortSignal; timeout classifies as certainty `unknown`, followed by release-only (never fail, never resubmit).
- Wedged-running: a `running` job with no lease that never settles. Closed by `failClaimedJob` recovery (same task identity redispatch; claiming worker re-evaluates definitiveness; budget released; job + ledger evidence preserved).
- Channel mismatch on TV: wrong-channel delivery surfaced. Closed by explicit `TV_CHANNEL_ID` discipline on the device path.
- `seed_pilot` text-only marker: legacy text-path seed marker misread as cartoon coverage. Closed by documenting it as text-only; cartoon-path coverage is the explicit separate suite (missing-image-config, definite still FAILED, definite video FAILED, ambiguous timeout release-only, classifier boundary).
- Host enqueue discipline: host path risked double-submit/self-block. Closed by scoped `generateHostVideo` entry (same pipeline, same selector), exactly-once enqueue, `created:false` reuse, `BUDGET_EXCEEDED` on a genuinely different seed while one job is in flight, no auto-enqueue on host-source upload completion.
- Pending intent queue: busy-party completions risked silent eligible-forever. Closed by durable pending intents with bounded created-gated dispatch, withdrawal/expiry recheck at dispatch, and `unavailable` reserved for genuine admission/terminal errors.

### 4. Closure verification (safe window restored)

- `predeploy`/`package.json` + `.env.halloween-tv` restored to default-deny (fake provider, generation off).
- Redeployed in the safe window.
- Generation-disabled proven: a fresh eligible upload created no job and no pending intent.
- `runGeneration` queue verified empty; all live jobs terminal (failed/purged); no running workers.
- Probe submission withdrawn through its supported authorization path.
- Host previews retained (approved clips available; no destructive deletes performed).

### 5. Device proof pointers (sanitized)

- TV live wall v1: fixtures hash-MATCHED against pinned references.
- HOST QR panel: invite + pairing code panel rendered (contents not recorded here).
- GUEST CODES / LIST: 6 seeded guests displayed.
- Wall v3 cartoon CAM-01 rendered on hardware; cached post-purge playback observed (preview retention path).
- Phone proof blocked twice by external prerequisites (no bypass attempted, TV Wi-Fi untouched): first attempt the phone was locked (owner unlock needed); second attempt the USB device disappeared from `adb` (reconnect prerequisite). At that rollout check, phone proof remained pending owner unlock + reconnect; the subsequent phone acceptance below supersedes that boundary.

### 6. Limitations (honest)

- Case-1 unknown POST is counted as spent without proof of execution (no confirmed submit, no artifact; conservative accounting against the ceiling).
- Credits UNKNOWN: ledger null everywhere; no console reconciliation performed, so realized spend is unstated.
- No further paid generations were submitted after safe closure. Final-source parent verification passed 234/234 full backend emulator tests and 104/104 TV tests, with clean TV analysis; these are distinct from the earlier live-provider evidence.
- At the rollout check, phone proof was pending unlock/reconnect; subsequently verified in the phone acceptance below.


## Final independent rollout acceptance (2026-10-31)

- Tested merged source: `f6cde52c1a6390e392f6d4173bac000d7f76efda`. `npm run test:emulator` (including TypeScript build) passed **234/234**, with zero failures/skips. TV `flutter test --no-pub --reporter json` passed **104/104** (12 hidden runner/loading events excluded); `flutter analyze --no-pub` found no issues. The containing closure commit changes documentation/evidence only; backend and TV source trees match the tested revision.
- Parent source review closed the two missing-image-config/definitive-cartoon-FAILED findings and verified the unknown-outcome no-fail/no-resubmit boundary. No fresh three-role harness review covers the final rollout diff; earlier verdicts keep their original scope.
- Independent read-only cloud checks found all **20** exports ACTIVE (19 in the primary region plus the ingest trigger), none generation-enabled, video provider `fake`, image provider absent, zero queue tasks/pending intents, and an idle generation budget. `hostInvites.expiresAt` TTL is ACTIVE and its collection-group index READY.
- Both registered-TV ACKs (v2/v3) match the independently recomputed canonical manifest hashes and all clip hashes. All eight delivery objects are absent after purge; all eight retained preview objects were downloaded read-only and independently byte/size-hashed against those manifests. Local CAM-01 videos were independently probed as silent H.264/yuv420p, 854x480, 24fps, 48 frames, 2.0 seconds.
- Parent reconnected only the already-authorized TV and directly observed the cartoon playing after cloud delivery purge (`WALL UPDATED · v3`); no Wi-Fi toggle, new paid request, or device-state bypass occurred. The installed release package is not debuggable, so direct extraction/hashing of its private cache was unavailable; evidence is the hash-bearing registered-TV ACK plus independently matched retained bytes and actual post-purge playback. This is not a network-isolation test. At that audit, physical phone proof was UNVERIFIED pending owner unlock and USB reconnect; the subsequent phone acceptance below supersedes that boundary.
- Budget accounting remains **two confirmed stills + one uncertain-reserved still**, **two videos**; no fourth case, blind retry, or ledger reset. Case-1's final cost rows are null-task/null-charge placeholders, not evidence of zero provider contact. Actual Credits remain **UNKNOWN**; no console reconciliation was performed.
- Machine-checkable, sanitized acceptance and external log hashes: [verification-f6cde52.json](cycle13/verification-f6cde52.json). Private portraits, generated media, screenshots, signed URLs, and credentials remain outside git. All existing branches, owner untracked files, and the stash are retained during the authorized main integration.

## Phone pairing and View acceptance (2026-10-31 local)

- Source `5e3423dd26a0e1224ad9184b74971bd706672a2a`, based on already-pushed `77c1ef1`: fixed the dropped six-digit pairing code and app route pushes from a context above `MaterialApp`. The host panel, preview, host-photo and guest-photo routes use the app-owned Navigator.
- Parent independently ran the full companion suite on integrated main: **168/168 passed**, zero failures/skips, 21 hidden runner events excluded; analysis clean. Regression tests enter the real standalone app and assert the actual destination screens and callable payload, not just helper behavior. This diff has parent review, not fresh three-role harness approval.
- Owner scanned the TV Host QR successfully. Parent inspected the subsequent physical evidence: both retained cartoon CAM-01 previews show distinct moving frames and Playing status; latest guest lineup is v3; photo screen shows explicit unchecked consent and disabled upload, with no selection/submission. Phone returned to the host panel; no Generate or Delete actions.
- Installed release APK is independently byte-hashed against the child build artifact. Exact build-time source provenance is reported separately from byte equality; no unsupported artifact/source claim. See [sanitized acceptance](cycle13/verification-5e3423d-phone.json) for source, checks, log hashes and artifact boundary.
- Initial TV follow-up at phone acceptance was incomplete (CAM-01 cartoon, CAM-03 bars, CAM-02/04 dark). The completed content audit below supersedes that pending investigation; it does not claim four cartoons or network-isolated playback.
- Diagnostic side effect: one disposable mirror host remains active, reportedly filling host capacity (3/3). No device was revoked. No cloud redeployment or additional paid-media submission occurred; the closed batch and UNKNOWN realized Credits are unchanged.

## TV restart recovery and content correction (2026-10-31 local)

- Committed v3 cached playback is restored, with no TV source/APK update or cloud redeployment. Final hardware evidence shows CAM-01 case-3 cartoon, CAM-02/04 near-black fixtures and CAM-03 bars; effects on, four-up, no Signal Lost or open panels. Phone remains on its host panel with all three seeds preserved.
- Parent independently decoded all **5 unique retained files**, covering **8/8 acknowledged preview entries** by SHA-256/size. Every unique file decodes all 48 frames without errors. Spaced sampled frames show two moving cartoons, near-black CAM-02/04 and color-bar CAM-03; these match the inspected TV screenshot.
- Important provenance correction: CAM-02..04 are **planned local fixture slots**, not provider-generated failures. The approved batch and `backend/functions/src/cartoon_pipeline.ts` specify one generated camera (CAM-01) plus three local fixtures. The child's initial “provider fallback” characterization is rejected.
- Earlier purged/missing-cache and current decoder-rejection explanations are superseded. Child reports successful full-cache boot/restore and clean current-v3 decoder logs; parent independently verified retained content and final screenshots, not private-cache extraction or the entire live codec exercise. The original transient Signal Lost cause is not independently proven.
- A four-cartoon wall was not produced by this batch; additional content remains outside this closed no-generation scope. No Generate/Delete/revoke, upload, provider submission, cache/data clear, uninstall, Wi-Fi toggle or backend role change. Host capacity remains reported 3/3, including the retained diagnostic mirror host.
- Companion source remains the independently tested `5e3423d` tree (168/168, clean analysis); TV/backend/shared source trees are unchanged. This closure is documentation/evidence only. See [sanitized final recovery record](cycle13/verification-95b501b-tv-recovery.json) for exact evidence/review boundaries.
