/// Root companion widget: join -> now-playing flow over [GuestSession].
///
/// Composes the p2 dependencies ([CompanionDependencies.create] resolving a
/// [BackendConfig] with unconfigured/offline default boot — no Firebase
/// init, no network) with the p3 [GuestSession] lifecycle. The join screen
/// collects identifiers, [GuestSession.join] binds them, and the
/// now-playing screen renders the latest published lineup from the session
/// state stream.
///
/// Test seam: [manifestSource] substitutes ONLY the callable boundary (the
/// `ManifestSource<PlaybackManifest>` port); parsing, session transitions,
/// and manifest mapping stay on the real production path.
library;

import 'package:channel_api/channel_api.dart' show ManifestSource;
import 'package:companion_app/src/bootstrap/companion_dependencies.dart';
import 'package:companion_app/src/config/backend_config.dart';
import 'package:companion_app/src/session/guest_session.dart';
import 'package:companion_app/src/session/guest_session_state.dart';
import 'package:companion_app/src/ui/join_screen.dart';
import 'package:companion_app/src/ui/now_playing_screen.dart';
import 'package:core_foundation/core_foundation.dart' show Clock, SystemClock;
import 'package:core_playlist/core_playlist.dart' show PlaybackManifest;
import 'package:core_ui/core_ui.dart' show CctvTheme;
import 'package:flutter/foundation.dart' show AsyncCallback;
import 'package:flutter/material.dart';

/// Root widget of the party companion guest app.
final class CompanionApp extends StatefulWidget {
  const CompanionApp({super.key, this.config, this.manifestSource, this.clock});

  /// Backend configuration override. Defaults to unconfigured/offline boot.
  final BackendConfig? config;

  /// Test seam: substitutes only the callable-boundary manifest source.
  final ManifestSource<PlaybackManifest>? manifestSource;

  /// Clock for last-successful-check timestamps.
  final Clock? clock;

  @override
  State<CompanionApp> createState() => _CompanionAppState();
}

final class _CompanionAppState extends State<CompanionApp> {
  GuestSession? _session;
  String? _unavailableReason;
  bool _booted = false;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    final Clock clock = widget.clock ?? const SystemClock();
    final ManifestSource<PlaybackManifest>? override = widget.manifestSource;
    if (override != null) {
      final GuestSession session = GuestSession(source: override, clock: clock);
      session.states.listen((GuestSessionState _) {
        if (mounted) {
          setState(() {});
        }
      });
      if (!mounted) {
        await session.dispose();
        return;
      }
      setState(() {
        _session = session;
        _booted = true;
      });
      return;
    }
    final CompanionDependencies dependencies =
        await CompanionDependencies.create(config: widget.config);
    if (!mounted) {
      return;
    }
    final GuestSession session = GuestSession(
      source: dependencies.manifestSource,
      clock: clock,
    );
    session.states.listen((GuestSessionState _) {
      if (mounted) {
        setState(() {});
      }
    });
    setState(() {
      _session = session;
      _unavailableReason = dependencies.remoteUnavailableReason;
      _booted = true;
    });
  }

  @override
  void dispose() {
    final GuestSession? session = _session;
    if (session != null) {
      final AsyncCallback dispose = session.dispose;
      dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Party Companion',
      theme: CctvTheme.dark(),
      home: _home(),
    );
  }

  Widget _home() {
    final GuestSession? session = _session;
    if (!_booted || session == null) {
      return const Scaffold(
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              CircularProgressIndicator(),
              SizedBox(height: 16),
              Text('Starting companion…', style: TextStyle(fontSize: 18)),
            ],
          ),
        ),
      );
    }
    final GuestSessionState snapshot = session.state;
    if (snapshot.join == null) {
      return JoinScreen(
        onJoin: session.join,
        configurationIssue: _unavailableReason,
      );
    }
    return NowPlayingScreen(
      state: snapshot,
      onRefresh: session.refresh,
      onLeave: session.leave,
    );
  }
}
