// infra_firestore: manifest source adapter + Firestore document mapping.
//
// Port direction (finding D-08): the `ManifestSource` port is owned by the
// contracts layer (`package:channel_api/channel_api.dart`). This barrel
// keeps re-exporting it (deprecated import path, see the annotation on the
// re-export in `src/manifest_source.dart`) so existing importers compile;
// new code imports the port from `channel_api` directly.
//
// Re-exports nothing from core_playlist on purpose: consumers depend on
// `package:core_playlist/core_playlist.dart` for domain types directly.

export 'src/manifest_source.dart';
