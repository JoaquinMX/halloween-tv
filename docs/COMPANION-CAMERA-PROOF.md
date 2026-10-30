# Companion camera join proof

## Status

The production fix and mocked-boundary regressions are present. Physical-camera proof is **pending**: this work session could not reach the Pixel (`adb` could not start its server: `could not install *smartsocket* listener: Operation not permitted`). No successful physical QR scan is claimed. Populate the evidence files only from a real device run.

## Device procedure (Pixel 4 XL, serial `9A291FFBA00654`)

1. From `apps/companion_app`, build the signed release APK using the existing `halloween-party.jks` configuration documented in `docs/RELEASE-SIGNING.md`; retain the live Firebase defines and do not clear app data.
2. Install with `adb -s 9A291FFBA00654 install -r build/app/outputs/flutter-apk/app-release.apk`. Confirm the existing device identity remains in app storage.
3. Revoke camera permission without clearing app identity: `adb -s 9A291FFBA00654 shell pm revoke <applicationId> android.permission.CAMERA`. Clear logcat, launch the app, tap **Scan QR**, then grant camera permission in the Android prompt. Confirm the live preview appears and capture logcat around the grant/start sequence.
4. Capture a screenshot with `adb -s 9A291FFBA00654 exec-out screencap -p > ../../docs/rehearsal-2026-10-30/cycle11-camera-preview.png` while the scanner preview is visible. Scan the actual party/session QR displayed by the TV. Confirm the joined lineup shows manifest v1 and all four cameras.
5. Repeat with cancellation: open **Scan QR**, close it, then reopen and scan. Confirm both the paste path and successful QR join remain available.
6. Repeat with background/resume: open scanner, background the app, resume it, and confirm the preview restarts and scans. Save sanitized logcat (remove device/account identifiers and tokens) to `docs/rehearsal-2026-10-30/cycle11-camera-logcat.txt`.

Record date/time, APK SHA-256, permission state, observed sequence, and outcome below after the physical run. Do not substitute a mocked scan or merely installed APK for the QR-to-lineup result.

## Device run record

Pending; no Pixel camera session was available in this work session.
