# Release signing — Halloween TV (Q4 party keystore)

- Keystore file: `halloween-party.jks` in the repo root. Gitignored (`*.jks`), never commit it.
- Alias: `halloween-party` (PKCS12).
- Passwords live only in a local secure note outside the repo. No passwords in Gradle files, `.env` files, or docs.

## Env vars (all four required for party-signed release)

- `KEYSTORE_PATH` — path to the keystore (defaults to the repo-root `halloween-party.jks` when unset).
- `KEYSTORE_PASSWORD` — keystore password.
- `KEY_ALIAS` — key alias (`halloween-party`).
- `KEY_PASSWORD` — key password.

## Release build command

```sh
KEYSTORE_PATH=/path/to/halloween-party.jks \
KEYSTORE_PASSWORD='<from secure note>' \
KEY_ALIAS=halloween-party \
KEY_PASSWORD='<from secure note>' \
flutter build apk --release
```

(Values come from the local secure note; never paste real passwords into the repo or shell history on shared machines.)

## Debug fallback behavior

If any of `KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD` is unset, or the keystore file does not exist,
`buildTypes.release` falls back to debug signing and emits a loud Gradle warning. `flutter run --release`
and debug builds keep working; the resulting APK is NOT party-signed.

## Key validity

Self-signed key, 30-year validity. Sideload-only — not for Google Play.

## Rotation

A new keystore (new key) means Android treats the app as a different signer: uninstall the old APK and
reinstall. Updates across different signing keys do NOT apply cleanly.
