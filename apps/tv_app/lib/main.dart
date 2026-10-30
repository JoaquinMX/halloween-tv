/// Halloween TV — Haunted Surveillance wall (Android TV, landscape, muted).
///
/// Boot order: kernel registry -> haunted_surveillance channel -> last
/// cached manifest (or bundled fixture) -> 2x2 wall with app-owned
/// `video_player` decoders per tile.
library;

import 'package:flutter/material.dart';

import 'package:tv_app/src/app.dart';
import 'package:tv_app/src/bootstrap/playback_dependencies.dart';
import 'package:tv_app/src/wall/manifest_store.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Android TV is landscape-only; the activity also pins landscape, this
  // keeps Flutter's view metrics consistent from the first frame.
  await lockLandscape();
  // The wall is muted (each tile sets volume 0) and keep-screen-on is
  // requested by the Android activity window flag — no Dart-side wakelock.
  final PlaybackDependencies dependencies = await PlaybackDependencies.create();
  runApp(
    HalloweenTvApp(
      boot: dependencies.createWallBoot(store: const PrefsManifestStore()),
    ),
  );
}
