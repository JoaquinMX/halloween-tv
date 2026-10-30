/// Party companion guest app — minimal scaffold entry point.
///
/// Boot order: ensure Flutter bindings, then run [CompanionApp].
///
/// NOTE (p1 scaffold): [CompanionApp] below is a TEMPORARY placeholder home
/// screen so the app boots and the widget test passes. The real
/// `CompanionApp` widget lands in `lib/src/companion_app.dart` in a later
/// partition (join flow). Do not add Firebase initialization, network
/// traffic, TV launcher theme, landscape lock, signing config, wakelock,
/// fixture assets, or playback code here.
library;

import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const CompanionApp());
}

/// Temporary scaffold placeholder. Replaced by the real companion flow.
class CompanionApp extends StatelessWidget {
  const CompanionApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      title: 'Party Companion (dev)',
      home: Scaffold(
        body: Center(child: Text('Companion scaffold — join flow lands in p4')),
      ),
    );
  }
}
