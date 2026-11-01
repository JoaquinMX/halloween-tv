/// Root companion widget: host entry -> guest join / host panel flows.
///
/// Boot lands on the dedicated host entry screen ([HostEntryScreen] with
/// Scan Host QR, paste/retry fallback, and an explicit Join-as-guest
/// route). Rationale for the dedicated entry: guest PIN admission is
/// intentionally broad — anyone who can see the TV screen can self-register
/// as a guest with full party-scoped read power — so host administration
/// must never be reachable through the guest PIN or a client-supplied role
/// string. The separate entry keeps the two routes visibly distinct and
/// makes the privilege boundary auditable: host payloads redeem only through
/// `joinHost` (separate phone identity, server-assigned host role) and guest
/// payloads register only through `joinParty`. A host payload submitted on
/// the guest form (or vice versa) fails visibly before any network call.
///
/// Composes the p2 dependencies ([CompanionDependencies.create] resolving a
/// [BackendConfig] with unconfigured/offline default boot — no Firebase
/// init, no network) with the guest [GuestSession] lifecycle and the host
/// [HostSession] lifecycle. The guest join screen collects identifiers;
/// each guest join scopes its own manifest source from the validated
/// [GuestJoinData] (a [FirebaseTvIdentity] derived from the guest-typed
/// party/device IDs, so they scope the actual callable payload), and the
/// now-playing screen renders the latest published lineup from the session
/// state stream. The host panel lists the server-backed seed catalog through
/// the scoped [HostMediaClient].
///
/// Production path: no `manifestSource` override means the session reads
/// through the real per-join composition
/// (`CompanionDependencies.manifestSourceForJoin` -> [ManifestConnection] ->
/// callable transport -> mapper -> validator). Test seams: [manifestSource]
/// substitutes ONLY the callable-boundary manifest source;
/// [firebaseBootstrap] and invoker overrides substitute only the
/// Firebase-init and callable-invoker boundaries for emulator/production-path
/// tests; parsing, sessions, routing, and response validation stay on the
/// real production path.
///
/// Lifecycle: the state observes app background/foreground transitions and
/// suspends both sessions on background (subscriptions cancelled, polling
/// stopped, last-known metadata retained) and resumes with fresh reads on
/// foreground return.
library;

import 'dart:async';

import 'package:channel_api/channel_api.dart' show ManifestSource;
import 'package:companion_app/src/bootstrap/companion_dependencies.dart';
import 'package:companion_app/src/config/backend_config.dart';
import 'package:companion_app/src/data/guest_media_client.dart';
import 'package:companion_app/src/data/host_join_client.dart';
import 'package:companion_app/src/data/host_media_client.dart';
import 'package:companion_app/src/data/party_join_client.dart';
import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:companion_app/src/session/guest_media_session.dart';
import 'package:companion_app/src/session/guest_session.dart';
import 'package:companion_app/src/session/guest_session_state.dart';
import 'package:companion_app/src/session/host_session.dart';
import 'package:companion_app/src/join/join_payload_scanner.dart';
import 'package:companion_app/src/ui/host_entry_screen.dart';
import 'package:companion_app/src/ui/host_panel_screen.dart';
import 'package:companion_app/src/ui/host_video_preview_screen.dart';
import 'package:companion_app/src/ui/join_screen.dart';
import 'package:companion_app/src/ui/now_playing_screen.dart';
import 'package:companion_app/src/ui/guest_photo_screen.dart';
import 'package:companion_app/src/media/guest_photo_picker.dart';
import 'package:core_foundation/core_foundation.dart' show Clock, SystemClock;
import 'package:core_playlist/core_playlist.dart' show PlaybackManifest;
import 'package:core_ui/core_ui.dart' show CctvTheme;
import 'package:flutter/material.dart';
import 'package:infra_firestore/infra_firestore.dart'
    show FirebaseManifestCallableInvoker;

/// Entry route shown after boot.
enum _EntryMode { hostEntry, guestJoin, hostPanel }

/// Root widget of the party companion app (guests + hosts).
final class CompanionApp extends StatefulWidget {
  const CompanionApp({
    super.key,
    this.config,
    this.manifestSource,
    this.clock,
    this.firebaseBootstrap,
    this.invokerOverride,
    this.partyJoinInvokerOverride,
    this.hostJoinInvokerOverride,
    this.hostMediaInvokerOverride,
  });

  /// Backend configuration override. Defaults to unconfigured/offline boot.
  final BackendConfig? config;

  /// Test seam: substitutes only the callable-boundary manifest source.
  final ManifestSource<PlaybackManifest>? manifestSource;

  /// Clock for last-successful-check timestamps.
  final Clock? clock;

  /// Test/emulator seam: substitutes only the Firebase-init boundary.
  final FirebaseBootstrap? firebaseBootstrap;

  /// Test/emulator seams: substitute only the callable-invoker boundaries.
  final FirebaseManifestCallableInvoker? invokerOverride;
  final PartyJoinCallableInvoker? partyJoinInvokerOverride;
  final HostJoinCallableInvoker? hostJoinInvokerOverride;
  final HostMediaCallableInvoker? hostMediaInvokerOverride;

  @override
  State<CompanionApp> createState() => _CompanionAppState();
}

final class _CompanionAppState extends State<CompanionApp>
    with WidgetsBindingObserver {
  /// Navigator owned by the app, below [MaterialApp].
  ///
  /// Route pushes must go through this key: this State's own [context] lives
  /// above [MaterialApp] and has no [Navigator] ancestor, so
  /// `Navigator.of(context)` throws a FlutterError and never navigates.
  final GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();
  GuestSession? _session;
  HostSession? _hostSession;
  StreamSubscription<GuestSessionState>? _statesSubscription;
  StreamSubscription<HostSessionState>? _hostStatesSubscription;
  CompanionDependencies? _baseDependencies;
  BackendConfig? _resolvedConfig;
  String? _unavailableReason;
  bool _booted = false;
  _EntryMode _mode = _EntryMode.hostEntry;

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
          hostJoinInvokerOverride: widget.hostJoinInvokerOverride,
          hostMediaInvokerOverride: widget.hostMediaInvokerOverride,
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

  void _attachHost(HostSession session) {
    _hostStatesSubscription?.cancel();
    _hostStatesSubscription = session.states.listen((HostSessionState _) {
      if (mounted) {
        setState(() {});
      }
    });
  }

  /// Joins as [data], scoping a fresh session source from the validated
  /// guest identifiers (production path) or reusing the substituted
  /// callable-boundary source (seam path).
  Future<void> _handleGuestJoin(GuestJoinData data) async {
    // Double-guard: the guest form already rejects host payloads; the
    // router never registers one through joinParty either.
    if (data.role != JoinRole.guest) {
      throw StateError(
        'Guest join cannot redeem a host invitation. Use the host entry.',
      );
    }
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
          hostJoinInvokerOverride: widget.hostJoinInvokerOverride,
          hostMediaInvokerOverride: widget.hostMediaInvokerOverride,
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

  /// Redeems a host payload and enters the panel only after the server
  /// validates the returned party/channel/device/host scope.
  ///
  /// Throws a sanitized message (via [HostJoinException]) when redemption or
  /// the catalog load fails, so the entry screen fails visibly.
  ///
  /// Legacy path: no pairing code (older callers). The server still
  /// requires the code, so this denies generically without it.
  Future<void> _handleHostJoin(GuestJoinData data) =>
      _redeemHost(data, null);

  /// Preferred path: redeems a host payload together with its validated
  /// 6-digit pairing code. The code is forwarded, never logged.
  Future<void> _handleHostJoinWithCode(
    GuestJoinData data,
    String pairingCode,
  ) => _redeemHost(data, pairingCode);

  Future<void> _redeemHost(GuestJoinData data, String? pairingCode) async {
    if (data.role != JoinRole.host) {
      throw StateError(
        'Host entry needs a Host QR invitation. Join as a guest instead.',
      );
    }
    CompanionDependencies? base = _baseDependencies;
    base ??= await CompanionDependencies.create(
      config: _resolvedConfig ?? BackendConfig.unconfigured(),
      firebaseBootstrap: widget.firebaseBootstrap,
      invokerOverride: widget.invokerOverride,
      partyJoinInvokerOverride: widget.partyJoinInvokerOverride,
      hostJoinInvokerOverride: widget.hostJoinInvokerOverride,
      hostMediaInvokerOverride: widget.hostMediaInvokerOverride,
    );
    if (!mounted) return;
    final CompanionDependencies resolved = base;
    if (_baseDependencies == null) {
      setState(() {
        _baseDependencies = resolved;
        _unavailableReason = resolved.isLive
            ? null
            : resolved.remoteUnavailableReason;
      });
    }
    final HostJoinClient? joinClient = resolved.hostJoinClient;
    final HostMediaClient? mediaClient = resolved.hostMediaClient;
    if (joinClient == null || mediaClient == null) {
      throw StateError(
        _unavailableReason == null
            ? 'Host administration is unavailable.'
            : 'Backend is not configured: $_unavailableReason',
      );
    }
    final HostSession? previous = _hostSession;
    final HostSession session = HostSession(
      joinClient: joinClient,
      mediaClient: mediaClient,
    );
    _attachHost(session);
    if (previous != null) {
      await previous.dispose();
    }
    if (!mounted) {
      await session.dispose();
      return;
    }
    setState(() {
      _hostSession = session;
    });
    // Throws sanitized HostJoinException on denial/failure: the panel is
    // entered only after the scope validates.
    await session.join(data, pairingCode: pairingCode);
    if (!mounted) return;
    setState(() {
      _mode = _EntryMode.hostPanel;
    });
  }

  Future<void> _handleHostLeave() async {
    final HostSession? session = _hostSession;
    unawaited(_hostStatesSubscription?.cancel());
    _hostStatesSubscription = null;
    _hostSession = null;
    if (session != null) {
      await session.dispose();
    }
    if (mounted) {
      setState(() {
        _mode = _EntryMode.hostEntry;
      });
    }
  }

  void _openHostPreview(String seedId) {
    final HostSession? session = _hostSession;
    final NavigatorState? navigator = _navigatorKey.currentState;
    if (session == null || navigator == null) return;
    navigator.push(
      MaterialPageRoute<void>(
        builder: (_) =>
            HostVideoPreviewScreen(session: session, seedId: seedId),
      ),
    );
  }

  void _openHostPhoto() {
    final HostSession? session = _hostSession;
    final GuestJoinData? binding = session?.binding;
    final GuestMediaClient? client = _baseDependencies?.guestMediaClient;
    final NavigatorState? navigator = _navigatorKey.currentState;
    if (session == null ||
        binding == null ||
        client == null ||
        navigator == null) {
      return;
    }
    final GuestMediaSession mediaSession = GuestMediaSession(
      client: client,
      partyId: binding.partyId.value,
      deviceId: binding.deviceId.value,
      channelId: binding.channelId,
      receiptsKey: GuestMediaSession.hostReceiptsKey,
      receiptKey: GuestMediaSession.hostReceiptKey,
    );
    navigator.push(
      MaterialPageRoute<void>(
        builder: (_) => GuestPhotoScreen(
          session: mediaSession,
          picker: NativeGuestPhotoPicker(),
        ),
      ),
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final GuestSession? session = _session;
    final HostSession? hostSession = _hostSession;
    switch (state) {
      case AppLifecycleState.paused:
        if (session != null) {
          unawaited(session.suspend());
        }
        if (hostSession != null) {
          unawaited(hostSession.suspend());
        }
      case AppLifecycleState.resumed:
        if (session != null) {
          unawaited(session.resume());
        }
        if (hostSession != null) {
          unawaited(hostSession.resume());
        }
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
    _hostStatesSubscription?.cancel();
    final GuestSession? session = _session;
    if (session != null) {
      unawaited(session.dispose());
    }
    final HostSession? hostSession = _hostSession;
    if (hostSession != null) {
      unawaited(hostSession.dispose());
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Halloween TV - Guests',
      theme: CctvTheme.dark(),
      navigatorKey: _navigatorKey,
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
    if (_mode == _EntryMode.hostPanel) {
      final HostSession? hostSession = _hostSession;
      if (hostSession != null) {
        return HostPanelScreen(
          session: hostSession,
          onLeave: _handleHostLeave,
          onPreview: _openHostPreview,
          onPhoto: _baseDependencies?.guestMediaClient == null
              ? null
              : _openHostPhoto,
        );
      }
      // Session lost without leave (defensive): fall back to entry.
      _mode = _EntryMode.hostEntry;
    }
    if (_mode == _EntryMode.guestJoin) {
      final GuestSession? session = _session;
      if (session == null) {
        return JoinScreen(
          onJoin: _handleGuestJoin,
          onBack: () => setState(() => _mode = _EntryMode.hostEntry),
          configurationIssue: _unavailableReason,
          scanner: CameraJoinPayloadScanner(),
        );
      }
      final GuestSessionState snapshot = session.state;
      if (snapshot.join == null) {
        return JoinScreen(
          onJoin: _handleGuestJoin,
          onBack: () => setState(() => _mode = _EntryMode.hostEntry),
          configurationIssue: _unavailableReason,
          scanner: CameraJoinPayloadScanner(),
        );
      }
      return NowPlayingScreen(
        state: snapshot,
        onRefresh: session.refresh,
        onLeave: session.leave,
        onGuestPhoto: _baseDependencies?.guestMediaClient == null
            ? null
            : () {
                final NavigatorState? navigator =
                    _navigatorKey.currentState;
                if (navigator == null) return;
                final join = snapshot.join!;
                final mediaSession = GuestMediaSession(
                  client: _baseDependencies!.guestMediaClient!,
                  partyId: join.partyId.value,
                  deviceId: join.deviceId.value,
                  channelId: join.channelId,
                );
                navigator.push(
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
    return HostEntryScreen(
      onHostJoin: _handleHostJoin,
      onHostJoinWithCode: _handleHostJoinWithCode,
      onJoinAsGuest: () => setState(() => _mode = _EntryMode.guestJoin),
      configurationIssue: _unavailableReason,
      scanner: CameraJoinPayloadScanner(),
    );
  }
}
