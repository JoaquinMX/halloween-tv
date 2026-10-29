# ADR 0002 — Cycle-2 scoped fixes: D-08 exception, analyzer honesty, CacheStore Phase-2, melos status

- Status: accepted (items 2–4 record fact; item 1 is a conditional grant)
- Date: 2026-10-29
- Partition: p5 repo-hygiene-lows (Halloween TV)

## 1. D-08 ports-restructure exception (p4)

ADR 0001 encodes design D-08 dependency-direction rules
(contracts `<-` adapters; `core_*` never depends on `channel_*`,
`infra_*`, or `kernel_app`). Partition p4
(`orchestrator-cycle-2-part-p4-contracts-playlist-ports`) owns the
contracts/playlist ports restructure.

Fact (corrected at merged head): p4 **has landed** — commit `7e32d48`
(`cycle-2 part p4-contracts-playlist-ports`), merge `72223a7`
(`cycle-2 merge p4`). The "no landed diff" sentence above was true at the
time of writing and is now superseded by this paragraph.

Verified final p4 edge set (all point in the ADR 0001 direction; grant
satisfied, no amendment needed):
- `channel_api` -> `core_foundation` only;
- `core_playlist` -> `core_foundation` only;
- `core_cache` -> `core_foundation` + `core_playlist` only;
- `core_effects` no longer -> `core_ui` (declared path dependency
  removed; `core_ui` legitimately depends on `core_effects`);
- `infra_firestore` / `infra_settings` -> `channel_api` (adapters consume
  the contracts port; no `core_*`/`channel_*` edge points the wrong way).

Decision — narrow conditional grant: p4 may relocate port
declarations **among contract packages only**
(`channel_api`, `core_cache`, `core_playlist`, `core_foundation`)
without a new ADR, provided every resulting edge still points in
the ADR 0001 direction. Any edge that would violate the direction
rules (e.g. a `core_*` package depending on a `channel_*`,
`infra_*`, or `kernel_app` package) requires an explicit amendment
here **before** merge. Merge gate: the orchestrator confirms the
final p4 edge set against ADR 0001 §Dependency-direction rules.

## 2. `dart analyze`, recorded honestly

Environment: Flutter 3.47.7 / Dart 3.13.5 (stable), melos 6.3.3.

- Fresh-checkout root `dart analyze`: **2810 issues**, dominated by
  `uri_does_not_exist` / `undefined_identifier` cascades
  (e.g. `package:flutter/material.dart` unresolvable). Cause: no
  `.dart_tool/` exists in this worktree — per-package
  `flutter pub get` never ran here. ADR 0001's "No issues found!"
  is therefore **not reproducible from a fresh checkout**; it
  assumed prior per-package resolution.
- After `flutter pub get --offline` in each touched package,
  `dart analyze packages/core_ui packages/core_effects
  packages/testing_toolkit` reports **8 issues, all info-level
  lints, zero errors/warnings**:
  - `always_use_package_imports` ×4 (`cctv_tile.dart:6,7`,
    `hud_overlay.dart:9`, `signal_lost.dart:6` — relative
    `lib/` imports; pre-existing, outside this batch except the
    `hud_overlay.dart` line, which is left as-is to keep the diff
    minimal);
  - `prefer_const_constructors` ×3 (`core_ui_test.dart:212,214,217`,
    pre-existing);
  - `prefer_final_locals` ×1 (`testing_toolkit.dart:43`,
    pre-existing, file outside this partition).
- Root `dart analyze` stays red until full-workspace resolution
  exists — follow-up for whichever partition lands the root
  pubspec (see §4).

## 3. Phase-2 full CacheStore adapter follow-up

`FakeCacheStore` (`testing_toolkit`) is test-only and not a
production cache:

- `commit()` trusts the caller-supplied sha256 — it never hashes
  `bytes`;
- `deleteExpired()` clears **everything** and returns the count —
  there is no TTL or expiry policy;
- storage is a process-local `Map`, with no persistence.

Phase-2 production adapter must: hash bytes on `commit` and
reject mismatches, implement a real expiry policy, and persist
`localRef`s. The `CacheStore` port signature in `core_cache`
stays unchanged, so callers are unaffected.

## 4. melos status (probe, then revert)

- Baseline: melos 6.3.3 refuses to run — `Found a melos.yaml file
  ... but no local installation of Melos` (confirms ADR 0001).
- Probe: added a temporary root `pubspec.yaml` (`name:
  halloween_tv`, explicit `workspace:` list of all 14 members —
  13 `packages/*` + `apps/tv_app` — plus `dev_dependencies:
  melos: ^6.3.3`). `dart pub get --offline` fails with:
  `packages/channel_api/pubspec.yaml is included in the workspace
  from ./pubspec.yaml, but does not have 'resolution: workspace'.`
- Conclusion: **not trivially viable**. Enabling workspaces needs
  `resolution: workspace` in all 14 member pubspecs plus the root
  pubspec — all outside the p5 file list — so the probe file was
  deleted, `melos.yaml` is left untouched, and the `melos *`
  scripts remain aspirational until the workspace owner lands the
  root pubspec + member migrations.

## Verification (this partition)

- `flutter pub get --offline` in `core_ui`, `core_effects`,
  `testing_toolkit`: resolved (pub notes 2 packages with newer
  incompatible versions; resolution itself succeeds).
- `flutter test --no-pub` per package: core_ui 13 passed,
  core_effects 15 passed, testing_toolkit 12 passed.
- `git check-ignore -v apps/tv_app/.env` → ignored
  (`apps/tv_app/.gitignore:46`); root `**/.env*` also covers it.
  `.env.example` is explicitly re-included (`!**/.env.example`)
  and shows as committable (`??`) in `git status`.
- `.env.example` contains placeholder values only; zero secrets.
- `core_effects` no longer declares the `core_ui` path dependency
  (nothing under `packages/core_effects/lib` ever imported it;
  this also removes the declared `core_effects` ↔ `core_ui`
  dependency cycle, since `core_ui` legitimately depends on
  `core_effects`).
