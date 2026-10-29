// infra_settings: party-scoped settings adapters.
//
// Port direction (finding D-08): the `SettingsPort` port is owned by the
// contracts layer (`package:channel_api/channel_api.dart`). This barrel
// keeps re-exporting it (deprecated import path, see the annotation on the
// re-export in `src/settings_port.dart`) so existing importers compile; new
// code imports the port from `channel_api` directly.

export 'src/settings_port.dart';
