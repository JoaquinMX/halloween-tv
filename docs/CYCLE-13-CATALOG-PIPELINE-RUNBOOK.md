# Cycle 13 catalog pipeline runbook

## Scope and safety

This runbook covers the backend-owned cartoon pipeline on Alibaba Singapore Token Plan only: `qwen-image-3.0-pro` for stills (synchronous multimodal generation, in-process data URIs, no task polling) and `wan3.0-video` STANDARD for video (first_frame carried as an in-process data URI inside `input.media`, never hosted bytes). Video controls remain 2 seconds, 480P, silent, no watermark, and `prompt_extend=false`. The `cheap_demo` and `cameo_demo` preset locks remain unchanged. Do not use Google, Veo, or Imagen. The batch planner is preview-only; no live provider request, cloud migration, or deployment is part of preparation.

Owner UX: the guest does consent + upload only — no prompt, scene, or situation UI exists anywhere on the guest path, and the client must not supply a plan. The server randomly selects the catalog scenario + compatible situation at job setup (seeded RNG, versions/seed persisted immutably in the cartoon plan at creation; retries reuse, never reroll). Eligible-upload completion and ingest-finalization/replay races idempotently enqueue the backend-selected two-stage generation when generation is enabled, under the existing consent/budget guards: one persisted plan, one job, one enqueue, no reroll/rebill. Generation-disabled keeps upload fully operational.

## Gates and execution order

1. Review the 3-case preview with the owner. Each case needs an authorized portrait submission and the separately identified scene/style reference. Confirm fixed plan IDs, versions, seeds, model pins, and 9 fixture slots.
2. Obtain an owner-supplied maximum Token Plan Credit allowance. Record still-stage and video-stage budget inputs separately; do not estimate prices. Credits stay UNKNOWN (null) until the provider reports realized charges; only realized console Credits are billable truth. Stop if projected allowance cannot be reconciled or the owner has not approved the ceiling.
3. Run `npm run build`, `npm test`, and the emulator suite including `cartoon_delivery_e2e.test.ts`. The emulator test must exercise actual stored media bytes, normalized H.264/yuv420p/24fps/854x480 two-second media, four downloads, independent hashes, ACK/purge, preview retention, and withdrawal denial. Any emulator signing substitution must be named explicitly and is not production-equivalent.
4. Run `npm run runtime:prepare`, then the offline packaging preflight. Inspect generated artifacts and confirm no credentials, private photos, or signed URLs are included.
5. Before any separately authorized live batch, capture the approved exact scope (3 stills + 3 videos, 6 generated seconds, fixture slots, budget ceiling, consented portrait IDs), operator, date, and rollback owner. Reconcile provider task IDs and actual console Credit usage per stage after each submission; stop on a ceiling breach or any unrecognized charge.

Prepare the preview with `npm run cartoon:prepare -- --party=<id> --device=<id> --channel=<id> --max-credits=<owner-value>`. This command only prints a proposal; it cannot submit live work or write cloud data. Keep private portrait bytes in the authorized ingest path and out of review documents.

## Publication and delivery

Publication requires completed still and video stages and matching still-stage hash provenance. Offline-fake stills are marked `fixture:true` and publication refuses them for non-rehearsal jobs. Authorization is re-evaluated during publication replay and immediately before delivery URLs are issued. Guest consent is scoped to its submission, source hash, revision, and expiry. Explicitly approved legacy/operator/host seeds may be delivered without manufacturing mobile consent. Withdrawal, expiry, deletion, changed source, unknown binding, unreadable authorization records, and unauthorized bindings fail closed with stage-specific diagnostics.

The canonical manifest hash, 1/2/4-camera contracts, MIME/profile validation, idempotent ACK, and purge semantics remain required. Signed URLs are in-flight only and must never be persisted. Diagnose failures separately as manifest, authorization, signing, download, hash, or ACK. Reproduce the legacy-seed case through `createRuntimeServices`, `getCurrentManifest`, `getDeliveryUrls`, downloaded object bytes, independent SHA-256, then ACK and purge. A successful URL response alone is not a successful delivery.

## Reference provenance (factual note)

The 16 reference stills shipped under `assets/scenario_refs/` (one per catalog record, sha256/sizeBytes pinned in `scenario_catalog.v1.json`) are the style references for the `qwen-image-3.0-pro` still stage; the batch preview re-verifies each referenced file against its pinned hash before emitting a row. The supplied refs are expressly task-authorized for offline preview and emulator rehearsal (no live provider calls). Real boundaries that apply: the owner-supplied maximum Credit ceiling (preview refuses to run without it), no live submits from any preview tooling, no cloud writes from preparation, and server-owned prompt composition (the client never supplies prompts, scenes, or plans).

## Few-case preview (verbatim, 3 cases)

The following 3 cases are the exact output of `npm run cartoon:prepare -- --party=pilot --device=tv-pilot --channel=main --max-credits=10` (prompts byte-identical to the server composer; still-to-video role ordering preserved: the generated still becomes the video `first_frame`; the still stage takes subject_identity + style_scene).

### Case 1 — storybook-kitchen / kitchen-slapstick-chase (selection seed `cartoon-batch-case-1`)
- Scenario: `storybook-kitchen` version 1. Situation: `kitchen-slapstick-chase` version 1.
- Selection seed: `cartoon-batch-case-1`.
- Reference paths: `test/fixtures/guest_photo.jpg` (subject_identity byte-shape stand-in only; real batches use consented ingest portraits) and `assets/scenario_refs/5c0e9bf8-864a-4146-b2f7-4e04f5c2520e.JPG` (style_scene, sha256 `fd6a42315e77ea8992ce255a1bae6a97a5317e4c98bd0860204403d7780ea9b1`, 811504 bytes).
- Still: `cartoon-still-plan-04` version 1 seed 130103, `qwen-image-3.0-pro` (singapore). Video: `cartoon-video-plan-04`, `wan3.0-video` STANDARD 2s/480P/silent.
- Still prompt:
```
Subject and identity: use the subject_identity reference as the character identity. Redraw the person in the subject_identity reference (the uploaded subject) as a coherent, fully illustrated cartoon character; preserve the subject's actual distinctive attributes (glasses, facial hair, hairstyle, outfit) exactly as seen in the subject_identity reference, without photographic skin or pasted photographic details.
Static starting pose: a single unambiguous static pose at the opening of the scene, feet planted, facing the situation entrance; held still, no motion blur.
Scene and style: Bustling storybook kitchen with hearth cauldron and stone arches, empty of pre-existing characters Chowder Marzipan-City cartoon kitchen, wobbly hand-inked lines, textured ochre/magenta washes, squishy round shapes Constraints: Kitchen chase: slip on pots, hide behind cauldron; food gags only Kitchens only; steam and pot lids as cover; food gags only
Cast: empty of pre-existing characters; the only figures are the uploaded subject and the required situation characters.
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
Static starting pose: a single unambiguous static pose at the opening of the scene, feet planted, facing the situation entrance; held still, no motion blur.
Scene and style: Crowded spooky graveyard at night with glowing jack-o-lantern mound and tombstones Grim-Adventures Halloween cartoon graveyard, sickly green night glow, thick black outlines, flat purple stone Constraints: Outdoor horde chase fits perfectly; monster can join pumpkin mob; keep candy/graves, no gore Outdoor night/dusk chases; monster may join the mob; keep candy/graves/van livery
Cast: empty of pre-existing characters; the only figures are the uploaded subject and the required situation characters.
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
Static starting pose: a single unambiguous static pose at the opening of the scene, feet planted, facing the situation entrance; held still, no motion blur.
Scene and style: Quaint farmhouse sitting room with red armchair, rocker, rug and daylight windows Courage-the-Cowardly-Dog farmhouse living room, crunchy ink, dusty rose/red wood, garish green monster accents Constraints: Classic mask-scare beat fits; monster lunges, guest recoils; keep one monster only Domestic living rooms only; furniture wobbles, never breaks; no menace beyond spooky twist
Cast: empty of pre-existing characters; the only figures are the uploaded subject and the required situation characters.
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

Physical-TV observation checklist (pending until performed):

- Confirm the correct party/channel and all four expected camera tiles.
- Observe startup, playback, reconnect, and refresh behavior; record visible errors and timestamps.
- Confirm the preview remains available until ACK and that ACK removes the delivered manifest as expected.
- Withdraw the portrait consent and verify that a subsequent URL request is denied.
- Record device, build, emulator-signing differences, and operator observations. Emulator validation is not physical-TV validation.

Physical-TV and live-provider validation remain pending until separately authorized and performed.
