/// Party companion guest app — entry point.
///
/// Boot order: ensure Flutter bindings, then run [CompanionApp] (the real
/// join -> now-playing flow in `lib/src/companion_app.dart`).
///
/// Default boot is unconfigured/offline: no Firebase initialization and no
/// network traffic. A cloud target is only selected when an explicit,
/// validated [BackendConfig] is supplied through the composition root.
/// No TV launcher theme, landscape lock, signing config, wakelock, fixture
/// assets, playback, or registration code here.
library;

import 'package:companion_app/src/companion_app.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const CompanionApp());
}
