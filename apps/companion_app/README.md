# Party Companion (dev) — `companion_app`

Guest app (Android, iOS, Web) for Halloween TV. This partition (`p1`) is the
platform scaffold + entry point only: `lib/main.dart` boots a temporary
placeholder home screen (`Companion scaffold — join flow lands in p4`).

The real `CompanionApp` widget lands in `lib/src/companion_app.dart` in a
later partition (join flow). No Firebase initialization or network traffic
in the scaffold bootstrap.

## Getting Started

- `flutter pub get`
- `flutter analyze`
- `flutter test`

Display name is provisionally `Party Companion (dev)` — deliberately
distinct from the TV app (`Halloween TV`).
