# Cheap-demo owner gate — exactly ONE future live generation

**Status: GATE DOCUMENT ONLY. Nothing was generated, no provider was called,
no credentials were read or changed, live mode was NOT enabled, and no
message was sent.** This runbook authorizes nothing by itself. A future
operator may act on it only after recording an explicit affirmative owner
approval (reference + timestamp) per §3.

## 0. Scope — one live `cheap_demo` generation, nothing else

- Exactly ONE future live generation, and only with this preset
  (design §11.3 `cheap_demo`, code `CHEAP_DEMO_PRESET` in
  `backend/functions/src/config.ts`):
  `wan3.0-video`, 480p (`480P`), 2 seconds, silent (`audio: false`),
  1 output (`outputs: 1`), no retry (`maxAttempts: 1`,
  `max_generation_attempts: 1`), text-only (zero input-video duration,
  `seconds_in = 0`).
- Illustrative cost reference only (design §11.4): **about US$0.10 of
  notional on-demand output cost** for one 2-second `wan3.0-video` clip at
  the listed Singapore rate ($0.05/output-second). **Token Plan bills
  Credits, which may differ** — the realized console Credits are the only
  billable truth, recorded per §8.
- This document changes no code, no config, and no credentials. Both files
  in this partition are docs-only:
  `docs/CHEAP-DEMO-OWNER-GATE.md` (this file) and
  `docs/cheap-demo-credit-log-template.csv` (empty template).

## 1. Pre-approval and hard spend cap (granted by Joaquin for this cycle)

- Owner pre-approval for this cycle covers probe work up to a ceiling of
  **5 billable attempts per probe**.
- **Every billable attempt is logged** with its realized console credits in
  the credit-log format (§8). No attempt is ever logged with an estimate,
  a synthetic zero, or a multiplied value.
- **If the 5 attempts of the probe are exhausted, or more budget is needed,
  STOP.** Do not retry, do not regenerate, do not spend further. Route a
  simple-worded Telegram ask via the orchestrator and wait for a fresh
  affirmative approval before anything else billable happens.
- This gate document itself authorizes exactly ONE job / ONE provider
  submission (§5). Attempts 2–5 under the ceiling are NOT pre-authorized
  here — each needs its own fresh owner approval routed the same way.

## 2. Approval-request text (simple wording — copy verbatim, fill <> only)

The future operator sends exactly this text (via the orchestrator over
Telegram) and proceeds only on an explicit affirmative reply recorded
per §3:

> Hi Joaquin — may I run ONE cheap test video for party <PARTY> (job
> <JOB_ID>)? It uses the cheapest preset only: wan3.0-video, 480p,
> 2 seconds, silent, 1 video. A text-only request with no input video
> (0 seconds of input), made from our own consented prompt — no guest
> photos. Public list prices suggest about US$0.10 of on-demand output
> cost for this one clip, but our Token Plan bills Credits which may
> differ — I will check the real Credits in the console afterwards. The
> goal is only to prove one video can reach the TV and play, then be
> deleted. This approval covers this ONE job only; anything more needs a
> fresh approval from you.

Why each clause is present: preset (`wan3.0-video`, 480p, 2s, silent,
1 output); illustrative ~US$0.10 on-demand cost plus the
Token-Plan-credits-may-differ caveat; party/job identification; consented
owner prompt as the only source; zero input-video duration; intended TV
proof-then-delete purpose; one-job scope with fresh-approval-needed-for-more.

## 3. Approval capture (required before any live step)

- Require an **explicit affirmative approval reference** (owner's reply,
  e.g. Telegram message reference/quote) **plus a timestamp**, recorded in
  the deployment/change record alongside party ID, job ID, and operator name.
- Silence, ambiguity, emoji-only reactions, or a stale approval for a
  different job/party do NOT count. No reference + timestamp = no submission.
- The approval covers the single job named in the request only. A new
  party, new job, new preset, or any retry needs a fresh request per §2.

## 4. Forbidden paths for a one-generation approval

- **NEVER use the stock four-camera generation worker/CLI for this
  one-generation approval.** The checked-in worker fans out across all four
  `REQUIRED_CAMERA_IDS` (`CAM-01`…`CAM-04`) — running it would bill up to
  four provider submissions against a one-job approval.
- The only acceptable composition is the **bounded one-generated-slot +
  three-fixture-slot path**: exactly one camera slot is live-generated
  under this gate; the other three slots stay on verified local fixtures.
  If that bounded path is not implemented and reviewed, STOP and route back
  to the orchestrator — do not improvise with the four-camera worker.
- Never set `VIDEO_GENERATION_PROVIDER` to a live provider outside the
  single approved submission window, never place provider credentials in
  app code / manifests / Firestore public docs / `.env` files, and never
  leave live mode on afterwards (§9).

## 5. Idempotency — one durable job, one submission, never regenerate

- Create **exactly one durable job with one idempotency key** before any
  provider contact, and persist the returned **provider task ID** on that
  job row.
- Perform **exactly one provider submission** for that key. Then:
  - a duplicate Cloud Functions dispatch → reuses the stored task ID, never
    submits again (design §10.3: `jobId` is the idempotency key);
  - an **uncertain submission** (unknown whether the provider accepted it) →
    reconcile against the stored task ID / provider console; NEVER submit
    a second time to "be sure";
  - a **timeout** waiting for the provider → STOP, keep the single task
    record, route to the owner; NEVER resubmit as a retry;
  - a **failed delivery** (download/hash/ACK/purge failure) → STOP, keep the
    evidence, route to the owner; NEVER regenerate to "fix" delivery.
- `maxAttempts: 1` everywhere on this path. Crash recovery replays the
  recorded task; it never creates a new one.

## 6. Future sequence (follow in order; any STOP ends the run)

Mirrors the end-to-end lifecycle (design §10.2), bounded to one slot:

1. **Recheck consent/expiry.** Confirm the prompt source is owner-consented
   with no expiry, and the party/channel/TV registration is current.
2. **Verify config + single-task bound.** Confirm `cheap_demo` lock
   (model/resolution/duration/audio/outputs), `GENERATION_ENABLED` opt-in
   for this window only, one-generated-slot + three-fixture-slot
   composition, `maxAttempts: 1`, and poll/timeout/normalization-headroom
   agreement per the runbook. Record the effective non-secret settings.
3. **Submit once.** Single submission under the one idempotency key (§5).
4. **Retain the task ID.** Persist the provider task ID on the durable job
   row before polling.
5. **Poll the SAME task.** Poll only the retained task ID to completion.
6. **Retrieve/normalize.** Fetch the provider output, normalize to the
   H.264/yuv420p/24fps/480p profile, stage the single delivery MP4.
7. **Publish.** Publish the manifest version referencing one generated slot
   + three fixture slots.
8. **TV download/hash/cache.** TV fetches its short-lived delivery URL,
   downloads, verifies hash/size, and commits to app-private cache.
9. **ACK.** TV acknowledges; backend records the idempotent ACK
   (`deviceId, channelId, manifestVersion`).
10. **Verified purge.** Delete cloud source/generated/delivery objects for
    the version only after ACK; verify object absence.
11. **Post-purge playback.** Confirm the wall plays the cached clip offline
    with no backend connectivity required.
12. **Console-credit record/reconcile.** Match the durable
    `provider_task_id` to the provider console's final per-task usage,
    record realized `credits_charged` on the cost-log row (§8), and re-run
    read-only reconciliation (`usage:reconcile`), attaching before/after
    output to the record.
13. **Return to safe config.** Generation-disabled + fake provider
    (`GENERATION_ENABLED` unset/false, `VIDEO_GENERATION_PROVIDER=fake`),
    live credentials out of reach, offline APK path confirmed.

## 7. Stop conditions (STOP = halt, preserve evidence, route to owner)

- No explicit affirmative approval reference + timestamp (§3).
- Consent missing, expired, or not owner-provided; guest imagery involved.
- Config is not `cheap_demo`-locked, or the single-task bound
  (one-generated-slot + three-fixture-slot) is not verified.
- Duplicate dispatch, uncertain submission, provider timeout, or failed
  delivery — never regenerate (§5).
- 5-attempt probe ceiling reached, or more budget is needed — Telegram ask
  via the orchestrator, fresh approval required (§1).
- Provider credentials requested in code/manifest/Firestore/`.env`, or live
  mode would be left on.
- Any step's evidence (hash, ACK, purge verification, console credits) is
  missing — do not advance on assumptions.

## 8. Credit logging (realized console credits only)

- Log every billable attempt in the standing format (tracking doc gates):
  `model_id, preset_id, seconds_out, seconds_in, credits_charged,
  provider_task_id, created_at, success`.
- Start from `docs/cheap-demo-credit-log-template.csv` (header + commented
  example only — no real rows in this partition).
- `credits_charged` stays `UNKNOWN` until matched to the provider
  console's realized per-task Credits. Never write estimates, never write
  synthetic zero (fake-provider zeros are test-only), never multiply one
  task's charge across fixture slots.
- Reconciliation (`usage:reconcile`) must show the single camera/task row
  with the realized value; attach before/after output to the change record.
  Do not expose console evidence in public documents.

## 9. Return to generation-disabled fake config (mandatory closeout)

After the run — success or stop — restore the inert posture and verify it:

- `GENERATION_ENABLED` unset or `false`; `VIDEO_GENERATION_PROVIDER=fake`;
  no live-spend switch, no provider key, no Secret Manager value left
  staged for generation.
- Confirm the worker is back to refusing live dispatch and the offline
  wall plays from cache/bundled fixtures.
- Record the restored config + verification output in the change record.

---

*Self-checks performed when writing this gate (no live execution): header
exactness of the CSV template (`head -1` byte comparison); both files
present under `docs/`; no code/config/credential files touched
(`git status --short` shows only the two new docs); no provider,
credential, or live-mode strings added; approval text above is the text
quoted in the delivery summary.*

---

## Appendix A — STEP 2 owner-approved cameo batch (separate preset, same gate discipline)

**Status: GATE DOCUMENT APPENDIX ONLY. Nothing was generated, no provider
was called, no credentials were read or changed, live mode was NOT enabled,
and no message was sent.** Owner approval for STEP 2 (Joaquin, Telegram
2026-10-30 ~23:55 CST, fresh spend approval up to 5 attempts for this probe)
covers exactly one guest-bound 5-second reference-image cartoon clip; every
billable attempt is logged with realized console credits per §8, and attempts
beyond the ceiling need a fresh approval per §1.

- **Separate server preset `cameo_demo` — `cheap_demo` is never altered.**
  `cameo_demo` is `happyhorse-1.1-r2v`, 480p (`480P`), 5 seconds, silent
  (`audio: false`), 1 output (`outputs: 1`), no retry (`maxAttempts: 1`),
  reference-image input only. Text-only requests for this preset are rejected;
  it exists solely for the consented-reference batch.
- **Model choice + why.** `happyhorse-1.1-r2v` (reference-image-to-video) was
  chosen over `wan3.0-video` because the checked-in adapter performs no
  per-model capability validation and the repo carries no offline
  documentation establishing that `wan3.0-video` accepts a `reference_image`
  input at a 5-second duration. Verified offline via serialization fixtures
  only; no provider network call was made.
- **Billing caveat (surfaced, never estimated).** Reference inputs can bill
  input duration — the adapter surfaces the provider's realized
  `usage.input_video_duration` as `secondsIn`, and Token Plan Credits may
  differ from list prices. Only realized console Credits are billable truth;
  no estimate is recorded anywhere.
- **Fixed server prompt.** The STEP 2 approved prompt is baked in as the
  server constant `CAMEO_DEMO_PRESET`/`CAMEO_DEMO_PROMPT` exactly as approved
  (never caller-supplied, never logged).
- **Same execution shape as a guest-bound cheap job:** exactly ONE
  provider-generated camera slot (`CAM-01`, bound to the validated guest
  photo) plus three locally prepared fixture slots; guest-bound only
  (eligible `guestMediaId` required, consent rechecked at request, worker
  submission, and publication; tombstone/withdrawal races fail closed);
  fake provider reports the 5s shape offline for emulator proof; spend guard
  unchanged (fake under the rehearsal marker, configured provider otherwise).

## Appendix B — Cycle-13 fix-p4 provenance/batch note (gate discipline unchanged)

Provenance-scoped delivery (legacy/operator/host seeds deliverable
without fabricated mobile consent; withdrawn/expired/deleted/unknown
bindings fail closed with stage-specific diagnostics) and the cartoon
sample-batch planner (preview-only, mandatory owner `--max-credits`
ceiling, 16 stills + 16 2s videos + 48 fixture slots, Alibaba Singapore
only) change no spend authorization in this gate: exactly ONE live
generation per approval (§5), attempts 2–5 need fresh approvals (§1),
and physical-TV/live-provider validation stays pending until separately
authorized. Batch preparation and emulator verification performed in the
repository are not a deployment and do not enable live mode.
