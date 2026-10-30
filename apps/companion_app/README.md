# Halloween TV - Guests — `companion_app`

Guest app (Android, iOS, Web) for Halloween TV. This is the second Flutter
app in the monorepo alongside `apps/tv_app`. The standing owner gate in
`docs/IMPLEMENTATION-TRACKING.md` ("no secondary Flutter app without
Joaquin's explicit approval") was lifted for this run: owner approval for
this companion app was recorded for cycle-6, scoped to a controlled pilot
(see below).

## What it does

Anonymous join + read-only now-playing, nothing else:

- **Join:** the guest enters the organizer-provisioned `partyId`,
  `deviceId`, and `channelId` (typed fields or a pasted JSON object).
  Identifiers are validated locally for shape only — well-formed never
  means registered. There is no login, no Firebase Auth, no registration,
  and no server round-trip at join time.
- **Now playing:** the app invokes exactly one callable,
  `getCurrentManifest`, with exactly `{partyId, deviceId, channelId}`,
  and renders the latest published lineup (four cameras in `cctvSlots`
  wall order, manifest version, server publication time, last-successful-
  check time). The server decides access at manifest-read time
  (`FORBIDDEN`/`UNAUTHENTICATED` render as denial states).

Default boot is unconfigured/offline: with no backend selected the app
shows the join screen with a configuration banner and performs no Firebase
initialization and no network traffic. A cloud target is selected only
through an explicit, validated `BackendConfig` (build-time
`--dart-define` values via `BackendConfig.fromEnvironment()` in
`lib/main.dart`, or the documented `config/firebase.json` copy workflow
below).

## Controlled-pilot assumption

Party/device/channel IDs are provisioned out-of-band by the organizer for
a controlled pilot (known guests, known devices). The app treats join input
as untrusted data: extra JSON keys (URLs, endpoints, backend selectors,
auto-submit flags) are ignored and never acted upon.

## Bearer-capability disclosure

The party/device IDs are bearer capabilities: the same registered IDs
that authorize the read-only `getCurrentManifest` call also authorize
server-side ACK and generation callables. **This app never invokes those**
(the invoker rejects every callable name except `getCurrentManifest` and
every payload except exactly `{partyId, deviceId, channelId}`), but anyone
holding a provisioned ID pair could call them from elsewhere. Therefore:

- Provision **dedicated guest-only device IDs** for companion use.
- **Never reuse the TV's own device identity** for guest joins.
- Treat organizer-distributed join payloads like passwords: share them
  only with the intended guest, and rotate/revoke on the backend if one
  leaks.

## Spend and hardening

- **No live spend from this app:** the only callable it invokes is the
  read-only `getCurrentManifest`. Video-generation testing stays on the
  cheapest preset with explicit owner approval per the standing gates; this
  app cannot trigger generation.
- **Pending owner-gated hardening:** App Check enforcement and an explicit
  organizer pairing/approval step are not implemented in this pass and
  remain owner-gated follow-ups before any wider rollout.

## Backend options file

`config/firebase.example.json` holds `YOUR-` placeholders only. To target
a backend locally, copy it to `config/firebase.json` (git-ignored — never
commit real project IDs, keys, or emulator addresses) and fill in real
values. Placeholder values are rejected as unconfigured (fail closed).

## Release signing status

Release builds currently use the **debug keystore** (Flutter template
default: `signingConfig = signingConfigs.getByName("debug")` in
`android/app/build.gradle.kts`). They are **unsuitable for distribution**.
Before any distribution build, follow `docs/RELEASE-SIGNING.md` (party
keystore, env-gated passwords). No signing changes in this pass.

## Getting Started

- `flutter pub get`
- `flutter analyze`
- `flutter test`

Display name is `Halloween TV - Guests` (owner decision 2026-10-30) —
deliberately distinct from the TV app (`Halloween TV`).
