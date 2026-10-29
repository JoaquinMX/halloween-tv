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
