/// Party companion guest app — entry point.
///
/// Boot order: ensure Flutter bindings, then run [CompanionApp] (the real
/// join -> now-playing flow in `lib/src/companion_app.dart`).
///
/// The platform entry supplies a validated [BackendConfig] from build-time
/// `--dart-define` values ([BackendConfig.fromEnvironment]). With no defines
/// the config resolves to unconfigured/offline default boot: no Firebase
/// initialization and no network traffic until a cloud target is explicitly
/// selected. No TV launcher theme, landscape lock, signing config, wakelock,
/// fixture assets, playback, or registration code here.
library;

import 'package:companion_app/src/companion_app.dart';
import 'package:companion_app/src/config/backend_config.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(CompanionApp(config: BackendConfig.fromEnvironment()));
}
