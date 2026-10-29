# Owner questions (cycle-1, 2026-10-29)

OWNER QUESTION: Which exact TV box/model + Android API level will run the party wall, and is 1080p output OK (vs 4K)?
OWNER QUESTION: OK to use ffmpeg-made synthetic clips (static/noise rooms, no stock footage) as the Phase-1 fixtures?
OWNER QUESTION: Keep CAM-01..04 labels as hallway / kitchen / staircase / storage room for the party?
OWNER QUESTION: The release APK is currently signed with the debug key — OK for the party sideload, or should I generate a dedicated party keystore before Oct 31?
OWNER QUESTION: Can I get 30 minutes with the actual TV box before the party to run a release build with Wi-Fi off (soak test all four tiles)?

## Owner answers (2026-10-29, via Telegram)

- Q1 TV box + resolution: Canvas TV 65S7SG. Target 1080p, must validate from 720p up. Grid-fit work covers 720p + 1080p.
- Q2 Synthetic ffmpeg clips for Phase-1: YES approved.
- Q3 CAM labels hallway/kitchen/staircase/storage: YES, but labels must be easy to replace later (config-driven, no hardcode).
- Q4 Party keystore vs debug key: PENDING.
- Q5 30-min soak on actual TV box Wi-Fi off: PENDING.

- Q4 decision (2026-10-29): party keystore `halloween-party.jks` generated (alias `halloween-party`); release signing env-driven with debug fallback kept.

## Q4 follow-up (2026-10-29) — explanation sent to owner

- A debug key is like a "test copy" sticker: the TV installs it fine for the party, but Android will not accept future updates to it and no app store will take it.
- A party keystore is a 5-minute one-time setup that signs the app properly, so installs are cleaner and later updates just work.
- Recommendation: stay on the debug key for the Oct 31 party unless store distribution or seamless updates matter — awaiting explicit Q4 decision.

## Q5 follow-up (2026-10-29) — owner authorizes ADB-over-WiFi proposal

- Owner: "We will be running tests in general. If you find a way to connect to the TV you are free to do it. Just let me know to ensure everything is ok."
- Builder will propose discovery/ADB steps, list needs, coordinate a test window. No blind network steps; wait for owner go-ahead per step.

## Q5 soak result (2026-10-29) — PARTY CERTIFIED

- Owner ran the wall with TV Wi-Fi OFF: all 4 tiles kept playing, no freezes, no black tiles.
- Certifies: offline-first boot, 4-decoder concurrency on Hisense CanvasTV S7 (Android 12, 1080p), no network dependency in Phase-1 path.
- Release APK (party-signed, 46MB) installed via ADB; debug fallback build proven.
