# Halloween TV

Android TV CCTV wall with a byte-verified bundled fallback and optional
Firebase live delivery. Backend selection comes only from Dart build defines;
the app never reads `.env` files or provider/service-account credentials.

## Offline playback

Offline is the default and does not initialize Firebase:

```sh
cd apps/tv_app
flutter run
```

The boot sequence first checks the app-private committed media index. If it is
missing or invalid, the bundled fixture manifest and its four assets are
verified by size and SHA-256 before they are displayed. The old
`PrefsManifestStore` key remains a separate compatibility cache and is never
used as the remote committed index.

## Emulator playback

Copy `config/firebase.example.json` to the ignored
`config/firebase.local.json`, then replace the angle-bracket values with the
emulator project's Firebase client options and provisioned party/device IDs.
For an Android emulator, the example uses host `10.0.2.2`; change it to the
reachable emulator host for other devices. Do not add callable tokens or
service-account values. Start Firestore on port 8080 and Functions on port
5001, then run:

```sh
flutter run --dart-define-from-file=config/firebase.local.json
```

Live mode requires `BACKEND_MODE=emulator`, non-empty project/app/client
options, provisioned `TV_PARTY_ID` and `TV_DEVICE_ID`, and valid emulator
addresses. Functions use `FUNCTIONS_REGION` (default `us-central1`). Missing
or rejected live configuration leaves the verified offline wall available.
Emulator cleartext traffic is allowed in the Android debug manifest only;
release builds retain HTTPS-only network policy.

## Review and release checks

Run these from `apps/tv_app` before handing off a build:

```sh
flutter pub get
flutter analyze
flutter test
flutter build apk --release
```

The build command only produces a local APK. It does not deploy Firebase,
publish media, provision identities, or contact a generation provider. The
APK requires the project's normal release-signing setup before distribution.

## Playback recovery

Press MENU or hold OK to open the recovery panel. `RETRY CACHED WALL`
re-verifies the app-private committed files before changing the wall;
`DISABLE EFFECTS` is saved in SharedPreferences under the current party ID and
restored on the next boot. Live manifests are staged and acknowledged before
activation, and each changed tile is replaced in sequence so the wall never
allocates more than four decoders.

## Host QR + guest codes

The recovery panel links two separately labelled destinations:

- `HOST QR`: the TV mints a short-lived host invite (`createHostInvite`)
  and shows exactly one QR plus the 6-digit pairing code beside it. Both
  are required on the companion host entry; a wrong code denies exactly
  like an unknown invite. Below the invite, active hosts are listed by
  label only (device ids never render) with a confirmed revoke action
  (`revokeHostDevice`, TV-only).
- `GUEST CODES`: party/channel scope plus one session QR for guests. The
  TV device id authorizes the listing request but is never displayed.

An unsupported manifest clip count (anything but 1, 2, or 4) fails
closed to a SIGNAL-LOST/cache state instead of throwing during
construction; a held D-pad direction keeps traversing through key
repeats while held select never retriggers the hero.
