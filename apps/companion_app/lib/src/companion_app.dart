/// Root companion widget: join -> now-playing flow over [GuestSession].
///
/// Composes the p2 dependencies ([CompanionDependencies.create] resolving a
/// [BackendConfig] with unconfigured/offline default boot — no Firebase
/// init, no network) with the p3 [GuestSession] lifecycle. The join screen
/// collects identifiers; each join scopes its own manifest source from the
/// validated [GuestJoinData] (a [FirebaseTvIdentity] derived from the
/// guest-typed party/device IDs, so they scope the actual callable
/// payload), and the now-playing screen renders the latest published
/// lineup from the session state stream.
///
/// Production path: no `manifestSource` override means the session reads
/// through the real per-join composition
/// (`CompanionDependencies.manifestSourceForJoin` -> [ManifestConnection] ->
/// callable transport -> mapper -> validator). Test seams: [manifestSource]
/// substitutes ONLY the callable boundary (the
/// `ManifestSource<PlaybackManifest>` port); [firebaseBootstrap] and
/// [invokerOverride] substitute only the Firebase-init and callable-invoker
/// boundaries for emulator/production-path tests; parsing, session
/// transitions, and manifest mapping stay on the real production path.
///
/// Lifecycle: the state observes app background/foreground transitions and
/// suspends the session on background (subscription cancelled, last-known
/// metadata retained) and resumes with a fresh read on foreground return.
library;

import 'dart:async';

import 'package:channel_api/channel_api.dart' show ManifestSource;
import 'package:companion_app/src/bootstrap/companion_dependencies.dart';
import 'package:companion_app/src/config/backend_config.dart';
import 'package:companion_app/src/data/party_join_client.dart';
import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:companion_app/src/session/guest_session.dart';
import 'package:companion_app/src/session/guest_session_state.dart';
import 'package:companion_app/src/join/join_payload_scanner.dart';
import 'package:companion_app/src/ui/join_screen.dart';
import 'package:companion_app/src/ui/now_playing_screen.dart';
import 'package:companion_app/src/ui/guest_photo_screen.dart';
import 'package:companion_app/src/media/guest_photo_picker.dart';
import 'package:companion_app/src/session/guest_media_session.dart';
import 'package:core_foundation/core_foundation.dart' show Clock, SystemClock;
import 'package:core_playlist/core_playlist.dart' show PlaybackManifest;
import 'package:core_ui/core_ui.dart' show CctvTheme;
import 'package:flutter/material.dart';
import 'package:infra_firestore/infra_firestore.dart'
    show FirebaseManifestCallableInvoker;

/// Root widget of the party companion guest app.
final class CompanionApp extends StatefulWidget {
  const CompanionApp({
    super.key,
    this.config,
    this.manifestSource,
    this.clock,
    this.firebaseBootstrap,
    this.invokerOverride,
    this.partyJoinInvokerOverride,
  });

  /// Backend configuration override. Defaults to unconfigured/offline boot.
  final BackendConfig? config;

  /// Test seam: substitutes only the callable-boundary manifest source.
  final ManifestSource<PlaybackManifest>? manifestSource;

  /// Clock for last-successful-check timestamps.
  final Clock? clock;

  /// Test/emulator seam: substitutes only the Firebase-init boundary.
  final FirebaseBootstrap? firebaseBootstrap;

  /// Test/emulator seam: substitutes only the callable-invoker boundary.
  final FirebaseManifestCallableInvoker? invokerOverride;
  final PartyJoinCallableInvoker? partyJoinInvokerOverride;

  @override
  State<CompanionApp> createState() => _CompanionAppState();
}

final class _CompanionAppState extends State<CompanionApp>
    with WidgetsBindingObserver {
  GuestSession? _session;
  StreamSubscription<GuestSessionState>? _statesSubscription;
  CompanionDependencies? _baseDependencies;
  BackendConfig? _resolvedConfig;
  String? _unavailableReason;
  bool _booted = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _boot();
  }

  Future<void> _boot() async {
    final Clock clock = widget.clock ?? const SystemClock();
    final ManifestSource<PlaybackManifest>? override = widget.manifestSource;
    if (override != null) {
      final GuestSession session = GuestSession(source: override, clock: clock);
      _attach(session);
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
    final BackendConfig resolved =
        widget.config ?? BackendConfig.unconfigured();
    _resolvedConfig = resolved;
    final CompanionDependencies dependencies =
        await CompanionDependencies.create(
          config: resolved,
          firebaseBootstrap: widget.firebaseBootstrap,
          invokerOverride: widget.invokerOverride,
          partyJoinInvokerOverride: widget.partyJoinInvokerOverride,
        );
    if (!mounted) {
      return;
    }
    setState(() {
      _baseDependencies = dependencies;
      // A live-but-unscoped composition reports no remote problem pre-join:
      // party/device identity arrives with the join flow and each join
      // scopes its own source. Only genuine config/init failures banner.
      _unavailableReason = dependencies.isLive
          ? null
          : dependencies.remoteUnavailableReason;
      _booted = true;
    });
  }

  void _attach(GuestSession session) {
    _statesSubscription?.cancel();
    _statesSubscription = session.states.listen((GuestSessionState _) {
      if (mounted) {
        setState(() {});
      }
    });
  }

  /// Joins as [data], scoping a fresh session source from the validated
  /// guest identifiers (production path) or reusing the substituted
  /// callable-boundary source (seam path).
  Future<void> _handleJoin(GuestJoinData data) async {
    final ManifestSource<PlaybackManifest>? override = widget.manifestSource;
    if (override != null) {
      final GuestSession? session = _session;
      if (session != null) {
        await session.join(data);
      }
      return;
    }
    final Clock clock = widget.clock ?? const SystemClock();
    final CompanionDependencies? base = _baseDependencies;
    final ManifestSource<PlaybackManifest> source =
        base?.manifestSourceForJoin(data) ??
        (await CompanionDependencies.create(
          config: _resolvedConfig ?? BackendConfig.unconfigured(),
          firebaseBootstrap: widget.firebaseBootstrap,
          invokerOverride: widget.invokerOverride,
          partyJoinInvokerOverride: widget.partyJoinInvokerOverride,
        )).manifestSourceForJoin(data);
    final GuestSession? previous = _session;
    final GuestSession session = GuestSession(
      source: source,
      clock: clock,
      joinClient: base?.partyJoinClient,
    );
    _attach(session);
    if (previous != null) {
      await previous.dispose();
    }
    if (!mounted) {
      await session.dispose();
      return;
    }
    setState(() {
      _session = session;
    });
    await session.join(data);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final GuestSession? session = _session;
    if (session == null) {
      return;
    }
    switch (state) {
      case AppLifecycleState.paused:
        unawaited(session.suspend());
      case AppLifecycleState.resumed:
        unawaited(session.resume());
      case AppLifecycleState.inactive:
      case AppLifecycleState.hidden:
      case AppLifecycleState.detached:
        break;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _statesSubscription?.cancel();
    final GuestSession? session = _session;
    if (session != null) {
      unawaited(session.dispose());
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Halloween TV - Guests',
      theme: CctvTheme.dark(),
      home: _home(),
    );
  }

  Widget _home() {
    if (!_booted) {
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
    final GuestSession? session = _session;
    if (session == null) {
      return JoinScreen(
        onJoin: _handleJoin,
        configurationIssue: _unavailableReason,
        scanner: CameraJoinPayloadScanner(contextOf: () => context),
      );
    }
    final GuestSessionState snapshot = session.state;
    if (snapshot.join == null) {
      return JoinScreen(
        onJoin: _handleJoin,
        configurationIssue: _unavailableReason,
        scanner: CameraJoinPayloadScanner(contextOf: () => context),
      );
    }
    return NowPlayingScreen(
      state: snapshot,
      onRefresh: session.refresh,
      onLeave: session.leave,
      onGuestPhoto: _baseDependencies?.guestMediaClient == null
          ? null
          : () {
              final join = snapshot.join!;
              final mediaSession = GuestMediaSession(
                client: _baseDependencies!.guestMediaClient!,
                partyId: join.partyId.value,
                deviceId: join.deviceId.value,
                channelId: join.channelId,
              );
              Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => GuestPhotoScreen(
                    session: mediaSession,
                    picker: NativeGuestPhotoPicker(),
                  ),
                ),
              );
            },
    );
  }
}
