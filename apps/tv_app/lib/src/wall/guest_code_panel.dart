/// Host-visible party code panel (D-pad settings overlay page).
///
/// Shows the party/channel session scope as text plus exactly one QR
/// encoding the authoritative anonymous session payload (opaque identifiers
/// only — never URLs, device ids, or secrets), and the joined guest device
/// list. The TV's own device id is NEVER rendered here: it authorizes the
/// host-only `listPartyDevices` request but stays off the screen, so guests
/// reading over a shoulder learn nothing. The session (scope + optional
/// PIN) always comes from the host-only `listPartyDevices` response via
/// [GuestCodeClient]; nothing is fabricated from build-time config.
///
/// Refresh: one fetch immediately on open plus a bounded periodic refresh
/// while visible. Overlapping requests are skipped, timers are cancelled on
/// disposal, and late responses after disposal are ignored. The last valid
/// session QR is retained across later refresh failures.
library;

import 'dart:async';

import 'package:core_ui/core_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';

import 'package:tv_app/src/wall/guest_codes.dart';

/// Key of the guest code panel.
const Key kGuestCodePanelKey = ValueKey<String>('guest-code-panel');

/// Key of the guest-code close button.
const Key kGuestCodeCloseKey = ValueKey<String>('guest-code-close');

/// Key of the guest-code back button (returns to the recovery actions).
const Key kGuestCodeBackKey = ValueKey<String>('guest-code-back');

/// Key of the single session QR (present only after authoritative data).
const Key kGuestCodeQrKey = ValueKey<String>('guest-code-qr');

/// Key of the session scope/PIN line.
const Key kGuestCodeSessionKey = ValueKey<String>('guest-code-session');

/// Key of the guest list body.
const Key kGuestCodeListKey = ValueKey<String>('guest-code-list');

/// Key of the loading indicator text.
const Key kGuestCodeLoadingKey = ValueKey<String>('guest-code-loading');

/// Key of the error text.
const Key kGuestCodeErrorKey = ValueKey<String>('guest-code-error');

/// Key of the empty-list text.
const Key kGuestCodeEmptyKey = ValueKey<String>('guest-code-empty');

/// Default bounded refresh interval while the panel is visible.
const Duration kGuestCodeRefreshInterval = Duration(seconds: 10);

/// Bounds a single listing fetch: without this, a hung callable would hold
/// `_fetching` true forever and wedge the panel (no retries, stale rows).
const Duration kGuestCodeFetchTimeout = Duration(seconds: 10);

/// Host panel: party/channel session scope (large text + session QR) and
/// the guest list.
///
/// Owns its listing refresh: fetches immediately on open and re-fetches on
/// [refreshInterval] while mounted. Pass a fake [GuestCodeClient.invoker] in
/// widget tests; production passes the real Cloud Functions client.
class GuestCodePanel extends StatefulWidget {
  /// Creates the host code panel.
  const GuestCodePanel({
    super.key,
    required this.client,
    required this.tvDeviceId,
    required this.onClose,
    this.onBack,
    this.primaryFocusNode,
    this.refreshInterval = kGuestCodeRefreshInterval,
  });

  /// Host-only listing reader (authorization carries the TV's device id).
  ///
  /// The id authorizes the request only and is never rendered: no screen
  /// may display the raw TV device id to guests.
  final GuestCodeClient client;

  /// TV's own device code (request authorization only; never displayed).
  ///
  /// Retained so the wall keeps passing its authorized identity through one
  /// seam; the panel renders party/channel scope from the authoritative
  /// listing instead.
  final String tvDeviceId;

  /// Closes the whole overlay.
  final VoidCallback onClose;

  /// Returns to the recovery actions; null hides the back button.
  final VoidCallback? onBack;

  /// Focus node for the first action, so the D-pad lands inside the panel.
  final FocusNode? primaryFocusNode;

  /// Bounded periodic refresh interval while visible.
  final Duration refreshInterval;

  @override
  State<GuestCodePanel> createState() => _GuestCodePanelState();
}

class _GuestCodePanelState extends State<GuestCodePanel> {
  GuestCodeListing? _listing;
  String? _error;
  bool _firstFetchDone = false;
  bool _fetching = false;
  int _generation = 0;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
    _timer = Timer.periodic(widget.refreshInterval, (_) {
      unawaited(_refresh());
    });
  }

  @override
  void dispose() {
    _generation++;
    _timer?.cancel();
    _timer = null;
    super.dispose();
  }

  Future<void> _refresh() async {
    if (_fetching || !mounted) {
      return;
    }
    _fetching = true;
    final int generation = _generation;
    try {
      final GuestCodeListing listing = await widget.client
          .fetchListing()
          .timeout(kGuestCodeFetchTimeout);
      if (!mounted || generation != _generation) {
        return;
      }
      setState(() {
        _listing = listing;
        _error = null;
        _firstFetchDone = true;
      });
    } on TimeoutException {
      // A hung fetch releases the in-flight guard so the next tick retries;
      // the last valid session (if any) is retained behind an inline error.
      if (!mounted || generation != _generation) {
        return;
      }
      setState(() {
        _error = 'guest list refresh timed out';
        _firstFetchDone = true;
      });
    } on Object catch (error) {
      if (!mounted || generation != _generation) {
        return;
      }
      setState(() {
        _error = error is GuestCodeException
            ? error.message
            : 'unexpected guest list failure';
        _firstFetchDone = true;
      });
    } finally {
      _fetching = false;
    }
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is KeyDownEvent) {
      if (event.logicalKey == LogicalKeyboardKey.contextMenu) {
        widget.onClose();
        return KeyEventResult.handled;
      }
      if (event.logicalKey == LogicalKeyboardKey.goBack ||
          event.logicalKey == LogicalKeyboardKey.escape) {
        (widget.onBack ?? widget.onClose)();
        return KeyEventResult.handled;
      }
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    return Focus(
      canRequestFocus: false,
      skipTraversal: true,
      onKeyEvent: _onKey,
      child: ColoredBox(
        color: const Color(0xE6000000),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 720),
            child: Container(
              key: kGuestCodePanelKey,
              padding: const EdgeInsets.all(28),
              decoration: BoxDecoration(
                color: const Color(0xFF101410),
                border: Border.all(color: CctvTheme.frameEdge, width: 2),
              ),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    const Text('GUEST CODES', style: CctvTheme.labelStyle),
                    const SizedBox(height: 8),
                    const Text(
                      'On the companion app, type or paste the party code '
                      'and PIN shown below. Camera QR scanning is not '
                      'available in this build.',
                      style: TextStyle(color: Colors.white70, fontSize: 18),
                    ),
                    const SizedBox(height: 20),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Expanded(child: _sessionLine()),
                        _qrBox(),
                      ],
                    ),
                    const SizedBox(height: 20),
                    const Text('GUEST LIST', style: CctvTheme.labelStyle),
                    const SizedBox(height: 8),
                    _guestListBody(),
                    const SizedBox(height: 20),
                    FocusTraversalGroup(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: <Widget>[
                          if (widget.onBack != null)
                            _PanelButton(
                              actionKey: kGuestCodeBackKey,
                              label: 'BACK',
                              focusNode: widget.primaryFocusNode,
                              onPressed: widget.onBack!,
                            ),
                          if (widget.onBack != null) const SizedBox(height: 10),
                          _PanelButton(
                            actionKey: kGuestCodeCloseKey,
                            label: 'CLOSE',
                            focusNode: widget.onBack == null
                                ? widget.primaryFocusNode
                                : null,
                            onPressed: widget.onClose,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _sessionLine() {
    final GuestCodeListing? listing = _listing;
    if (listing == null) {
      return Text(
        'party ${widget.client.partyId} · ${widget.client.channelId}',
        key: kGuestCodeSessionKey,
        style: const TextStyle(color: Colors.white70, fontSize: 18),
      );
    }
    final String pinText = listing.joinPin == null
        ? 'no PIN required'
        : 'PIN ${listing.joinPin}';
    return Text(
      'party ${listing.partyId} · ${listing.channelId} · $pinText',
      key: kGuestCodeSessionKey,
      style: const TextStyle(color: Colors.white70, fontSize: 18),
    );
  }

  /// Exactly one QR once authoritative session data exists; no fabricated
  /// PIN-free QR before the first successful fetch.
  Widget _qrBox() {
    final GuestCodeListing? listing = _listing;
    if (listing == null) {
      return Container(
        width: 204,
        height: 204,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          border: Border.all(color: CctvTheme.frameEdge),
        ),
        child: const Text(
          'Waiting for session…',
          textAlign: TextAlign.center,
          style: TextStyle(color: Colors.white70, fontSize: 16),
        ),
      );
    }
    final String payload = buildJoinPayload(
      partyId: listing.partyId,
      channelId: listing.channelId,
      joinPin: listing.joinPin,
    );
    return Container(
      padding: const EdgeInsets.all(12),
      color: Colors.white,
      child: QrImageView(
        key: kGuestCodeQrKey,
        data: payload,
        semanticsLabel: payload,
        size: 180,
        backgroundColor: Colors.white,
      ),
    );
  }

  Widget _guestListBody() {
    final GuestCodeListing? listing = _listing;
    if (!_firstFetchDone && listing == null && _error == null) {
      return const Text(
        'Loading guest codes…',
        key: kGuestCodeLoadingKey,
        style: TextStyle(color: Colors.white70, fontSize: 22),
      );
    }
    // First fetch failed with nothing valid to show: error, no QR, no rows.
    if (listing == null && _error != null) {
      return Text(
        'Guest list unavailable: $_error',
        key: kGuestCodeErrorKey,
        style: const TextStyle(color: Color(0xFFFFC107), fontSize: 22),
      );
    }
    final List<GuestCodeEntry> rows = listing?.devices ?? <GuestCodeEntry>[];
    if (rows.isEmpty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const Text(
            'No guests yet — new joins appear here automatically.',
            key: kGuestCodeEmptyKey,
            style: TextStyle(color: Colors.white70, fontSize: 22),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                'Refresh failed: $_error — showing last session.',
                key: kGuestCodeErrorKey,
                style: const TextStyle(color: Color(0xFFFFC107), fontSize: 18),
              ),
            ),
        ],
      );
    }
    return Column(
      key: kGuestCodeListKey,
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        for (final GuestCodeEntry entry in rows)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Text(
              '${entry.displayLabel}: ${entry.deviceId}',
              style: const TextStyle(color: Colors.white, fontSize: 26),
            ),
          ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              'Refresh failed: $_error — showing last session.',
              key: kGuestCodeErrorKey,
              style: const TextStyle(color: Color(0xFFFFC107), fontSize: 18),
            ),
          ),
      ],
    );
  }
}

/// Large, TV-focusable panel action.
class _PanelButton extends StatelessWidget {
  const _PanelButton({
    required this.actionKey,
    required this.label,
    required this.onPressed,
    this.focusNode,
  });

  final Key actionKey;
  final String label;
  final VoidCallback onPressed;
  final FocusNode? focusNode;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton(
      key: actionKey,
      focusNode: focusNode,
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        foregroundColor: Colors.white,
        side: const BorderSide(color: CctvTheme.frameEdge, width: 2),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        textStyle: CctvTheme.badgeStyle,
      ),
      child: Align(alignment: Alignment.centerLeft, child: Text(label)),
    );
  }
}
