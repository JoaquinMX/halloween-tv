# Cycle 13 catalog pipeline runbook

## Scope and safety

This runbook covers the backend-owned cartoon pipeline on Alibaba Singapore Token Plan only: `qwen-image-3.0-pro` for stills and `wan3.0-video` STANDARD for video. Video controls remain 2 seconds, 480P, silent, no watermark, and `prompt_extend=false`. The `cheap_demo` and `cameo_demo` preset locks remain unchanged. Do not use Google, Veo, or Imagen. The batch planner is preview-only; no live provider request, cloud migration, or deployment is part of preparation.

## Gates and execution order

1. Review the 16-row preview with the owner. Each row needs an authorized portrait submission and separately identified scene/style reference. Confirm fixed plan IDs, versions, seeds, model pins, and 48 fixture slots.
2. Obtain an owner-supplied maximum Token Plan Credit allowance. Record still-stage and video-stage budget inputs separately; do not estimate prices. Stop if projected allowance cannot be reconciled or the owner has not approved the ceiling.
3. Run `npm run build`, `npm test`, and the emulator suite including `cartoon_delivery_e2e.test.ts`. The emulator test must exercise actual stored media bytes, normalized H.264/yuv420p/24fps/854x480 two-second media, four downloads, independent hashes, ACK/purge, preview retention, and withdrawal denial. Any emulator signing substitution must be named explicitly and is not production-equivalent.
4. Run `npm run runtime:prepare`, then the offline packaging preflight. Inspect generated artifacts and confirm no credentials, private photos, or signed URLs are included.
5. Before any separately authorized live batch, capture the approved exact scope (16 stills + 16 videos, 32 generated seconds, fixture slots, budget ceiling, consented portrait IDs), operator, date, and rollback owner. Reconcile provider task IDs and actual console Credit usage per stage after each submission; stop on a ceiling breach or any unrecognized charge.

Prepare the preview with `npm run cartoon:prepare -- --party=<id> --device=<id> --channel=<id> --max-credits=<owner-value>`. This command only prints a proposal; it cannot submit live work or write cloud data. Keep private portrait bytes in the authorized ingest path and out of review documents.

## Publication and delivery

Publication requires completed still and video stages and matching still-stage hash provenance. Authorization is re-evaluated during publication replay and immediately before delivery URLs are issued. Guest consent is scoped to its submission, source hash, revision, and expiry. Explicitly approved legacy/operator/host seeds may be delivered without manufacturing mobile consent. Withdrawal, expiry, deletion, changed source, unknown binding, unreadable authorization records, and unauthorized bindings fail closed with stage-specific diagnostics.

The canonical manifest hash, 1/2/4-camera contracts, MIME/profile validation, idempotent ACK, and purge semantics remain required. Signed URLs are in-flight only and must never be persisted. Diagnose failures separately as manifest, authorization, signing, download, hash, or ACK. Reproduce the legacy-seed case through `createRuntimeServices`, `getCurrentManifest`, `getDeliveryUrls`, downloaded object bytes, independent SHA-256, then ACK and purge. A successful URL response alone is not a successful delivery.

## Reference-still licensing and IP hygiene (16 owner-approved frames)

The 16 reference stills shipped under `assets/scenario_refs/` (one per catalog
record, sha256/sizeBytes pinned in `scenario_catalog.v1.json`) are frames
from existing broadcast cartoons used as style references for the
`qwen-image-3.0-pro` still stage. Owner approval on file covers operational
consent to run the preview batch; it is not, by itself, a copyright license
for the underlying frames.

- Licensing basis: before any public or deployed batch, record the license
  basis for each of the 16 frames (licensed stock, public-domain source, or
  owner-created replacement) alongside the existing byte-hash provenance.
  Frames without a clear commercial-derivative basis must be replaced with
  owner-created references and re-pinned (new sha256/sizeBytes) before use.
- Scope of the current owner approval: offline preview and emulator rehearsal
  only (no live provider calls, no public display, no redistribution of the
  frames beyond the deployed artifact). Any live batch, public screening, or
  redistribution requires a fresh, explicitly scoped owner sign-off naming
  the licensing basis above.
- Catalog provenance (`scenario_catalog.v1.json` record hashes) is owned
  elsewhere and is not edited here; this runbook only records the IP-hygiene
  obligation and the approval-scope boundary.

## Rollback, retention, and physical TV check

Rollback by stopping new submissions, disabling publication for affected jobs, withdrawing impacted consent or deleting the affected seed through its supported authorization path, and purging only after the owner confirms retention obligations. Retain task/charge reconciliation, manifest hashes, ACK results, and sanitized diagnostic codes according to the applicable party retention policy; do not retain signed URLs or portrait bytes in logs.

Physical-TV observation checklist (pending until performed):

- Confirm the correct party/channel and all four expected camera tiles.
- Observe startup, playback, reconnect, and refresh behavior; record visible errors and timestamps.
- Confirm the preview remains available until ACK and that ACK removes the delivered manifest as expected.
- Withdraw the portrait consent and verify that a subsequent URL request is denied.
- Record device, build, emulator-signing differences, and operator observations. Emulator validation is not physical-TV validation.

Physical-TV and live-provider validation remain pending until separately authorized and performed.
