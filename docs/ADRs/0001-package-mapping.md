# ADR 0001 — Package mapping: Technical Design v1.0 vs. existing repo names

- Status: accepted
- Date: 2026-10-29
- Context: Technical Design v1.0 (2026-10-28, Halloween TV / Haunted
  Surveillance). Android TV only, Flutter + `video_player`, Melos + Pub
  Workspaces, modular monolith + microkernel + hexagonal (design D-08).

## Decision

**Keep the existing repo package names. Do NOT rename packages.** The design's
recommended tree is mapped onto the names that already exist in the repo:

| Design (recommended tree)        | Repo (kept)        | Concept                                            |
|----------------------------------|--------------------|----------------------------------------------------|
| `app_kernel`                     | `kernel_app`       | Microkernel: channel registry, composition root    |
| `media_domain` (playlist/manifest) | `core_playlist`  | Playlist / manifest domain                         |
| `media_local_cache`              | `core_cache`       | Local media cache (behind a port)                  |
| `infra_delivery`                 | `infra_signed_urls`| Signed-URL delivery adapters                       |
| `channel_retro`                  | `channel_retro_tv` | Retro-TV channel                                   |
| (direct match)                   | `channel_api`      | Channel contract (port)                            |
| (direct match)                   | `channel_cctv`     | Haunted-surveillance channel                       |
| (direct match)                   | `core_foundation`  | Shared contracts, result / error types             |
| (direct match)                   | `core_effects`     | Haunted visual / audio effects                     |
| (direct match)                   | `core_ui`          | Shared TV UI widgets (10-foot UI)                  |
| (direct match)                   | `infra_firestore`  | Firestore-backed adapters                          |
| (direct match)                   | `infra_settings`   | Settings persistence adapters                      |
| (direct match)                   | `testing_toolkit`  | Shared fakes and test helpers                      |
| (app shell)                      | `tv_app`           | Android TV app shell                               |

### Why keep the names

1. **Zero behavioral benefit to renaming.** A rename churns every `import`,
   every `melos --scope` filter, every CI path and every `.gitignore`, while
   changing nothing semantically.
2. **The mapping is a vocabulary problem, not a code problem.** Reading the
   table above is enough to move between design documents and code.
3. **Stability while other partitions land code.** Renaming now would collide
   with in-flight work across channels, core and infra partitions.
4. This ADR is the single source of truth for the mapping until a superseding
   ADR renames anything. Name a package by its *repo* name in code, and by the
   design concept in prose when quoting the design.

## Dependency-direction rules (design D-08, hexagonal / microkernel)

```
tv_app (app shell)
  -> kernel_app (composition root)
       -> channel_api, channel_cctv, channel_retro_tv   (channels)
            -> channel_api, core_foundation, core_playlist,
               core_cache, core_effects, core_ui        (contracts + core)
       -> infra_firestore, infra_settings, infra_signed_urls (adapters)
```

1. **app -> kernel -> channels -> contracts.** `tv_app` depends on `kernel_app`;
   `kernel_app` is the composition root and is the only place that wires
   concrete channels and concrete infrastructure adapters together.
2. **Channels never import `infra_*`.** `channel_cctv` and `channel_retro_tv`
   depend only on contracts and core (`channel_api`, `core_foundation`,
   `core_playlist`, `core_cache`, `core_effects`, `core_ui`). Deliverability
   (signed URLs, remote manifests, persisted settings) reaches a channel only
   through a port declared in the contracts layer and implemented in `infra_*`.
3. **`infra_*` implements ports; it never depends on `channel_*` or
   `kernel_app`.** Dependency direction is contracts <- adapters.
4. **`core_*` never depends on `channel_*`, `infra_*` or `kernel_app`.**
   `core_foundation` is the leaf and depends on nothing but Flutter.
5. **`testing_toolkit` depends only on contracts** and nothing production
   depends on it (it is a dev-only dependency of the packages/apps).
6. These edges are encoded in the `pubspec.yaml` path dependencies of each
   package, so a violating import fails at resolution/review time rather than
   being discovered later.

## Analyzer configuration

- `analysis_options.yaml` (repo root) is the canonical strict-ish baseline:
  strict casts/inference/raw types, `unused_import` / `dead_code` as errors,
  and the extra lint set. It deliberately contains **no** `package:` include,
  because the repo root is not (yet) a Dart package and such an include would
  not resolve when analyzing from the root.
- `apps/tv_app/analysis_options.yaml` includes both
  `package:flutter_lints/flutter.yaml` and the root baseline, so the app gets
  the full lint set plus the strictness.
- `packages/*/analysis_options.yaml` are **byte-identical** across all 13
  packages and include both `package:flutter_lints/flutter.yaml` and
  `../../analysis_options.yaml`, so a package cannot silently drift to looser
  rules than its siblings or than the app. (The package name is deliberately
  not embedded in the file, which is what makes byte-identity possible.)
- The shared rules are verified to be live, not inert: a scratch package whose
  `analysis_options.yaml` includes only the root baseline reports
  `unused_local_variable` as an **error** and `prefer_final_locals`,
  `prefer_const_declarations`, `avoid_print` as lints. An inert include would
  have reported nothing.

## Notes

- **Pub Workspaces is deliberately not enabled yet.** `resolution: workspace`
  in a member pubspec requires a root `pubspec.yaml` declaring `workspace:`.
  That root pubspec is not part of this partition, and enabling member-level
  workspace resolution before the root exists makes resolution fail outright —
  verified: `dart pub get` on a `resolution: workspace` pubspec without a
  parent workspace root aborts with *"But found no workspace root including it
  in parent directories."* Until the workspace root lands, the monorepo
  resolves through **path dependencies** (classic resolution), which
  `flutter pub get` and `flutter pub get --offline` both support. Switching to
  workspaces is then a one-line `resolution: workspace` per member plus the
  root `workspace:` list.
- **Melos tooling.** `melos.yaml` declares the package globs and scripts, but
  the installed CLI (melos 6.3.3) refuses to run here: since Melos 3.0 the
  `melos` package must be a dependency in a `pubspec.yaml` located next to
  `melos.yaml`, i.e. at the repo root — the same missing root pubspec. Actual
  output: *"Found a melos.yaml file ... but no local installation of Melos."*
  Verification for this partition therefore ran `flutter pub get` per package
  and `dart analyze` at the repo root instead of `melos bootstrap`; the
  scripts are ready for when the root pubspec lands.
- **`video_player` (`^2.9.0`, resolving to 2.14.1 on Flutter 3.47.7)** is
  declared on `tv_app` only. Channels program against playback ports in
  `channel_api`, so the player implementation stays swappable.

## Verification (this partition)

Environment: Flutter 3.47.7 / Dart 3.13.5 (stable), melos 6.3.3.

| Command | Result |
|---|---|
| `flutter pub get` in all 13 packages + `apps/tv_app` | resolved, exit 0 |
| `flutter pub get --offline` in `apps/tv_app`, `packages/kernel_app` | resolved from local pub cache, exit 0 |
| `dart analyze` at repo root | `No issues found!`, exit 0 |
| analyzer-rules probe (scratch pkg including the root baseline) | strict rules fire: `unused_local_variable` = error, `prefer_final_locals` / `prefer_const_declarations` / `avoid_print` = lints |
| `resolution: workspace` probe without a workspace root | fails as expected (no workspace root) |
| `melos bootstrap` | not runnable (melos 6.3.3 requires a local melos install next to `melos.yaml`) |

`video_player: ^2.9.0` locks to 2.14.1 and is the only third-party runtime
dependency of the app; every internal edge is a `path:` dependency, so the
dependency-direction rules above are enforced by resolution, not convention.
