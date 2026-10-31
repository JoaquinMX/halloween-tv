/// Host invite panel (TV settings overlay page, separately labelled HOST QR).
///
/// Shows exactly one QR encoding the scoped host invite capability
/// ([buildHostJoinPayload]: `partyId` + `channelId` + `inviteToken` +
/// `role: 'host'` — never the TV device identity), the session scope, and
/// the server-stated expiry. The invite always comes from the host-only
/// `createHostInvite` response via [HostInviteClient]; nothing is fabricated
/// from build-time config.
///
/// States: loading (no fabricated QR), ready (QR + REFRESH re-mint),
/// expired (stale capability hidden, refresh offered), denial/error (reason
/// shown, last valid session retained when one exists), and unavailable
/// (no [HostInviteClient] — the wall never opens this destination, like the
/// offline guest-codes path).
///
/// Refresh is manual (REFRESH re-mints) plus a 1s expiry ticker that hides
/// the QR the moment the invite lapses. Overlapping mints are skipped,
/// timers are cancelled on disposal, and late responses after disposal are
/// ignored.
library;

import 'dart:async';

import 'package:core_foundation/core_foundation.dart';
import 'package:core_ui/core_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';

import 'package:tv_app/src/wall/host_codes.dart';

/// Key of the host code panel.
const Key kHostCodePanelKey = ValueKey<String>('host-code-panel');

/// Key of the host-code close button.
const Key kHostCodeCloseKey = ValueKey<String>('host-code-close');

/// Key of the host-code back button (returns to the recovery actions).
const Key kHostCodeBackKey = ValueKey<String>('host-code-back');

/// Key of the single invite QR (present only with a live, unexpired invite).
const Key kHostCodeQrKey = ValueKey<String>('host-code-qr');

/// Key of the session scope/expiry line.
const Key kHostCodeSessionKey = ValueKey<String>('host-code-session');

/// Key of the manual refresh button.
const Key kHostCodeRefreshKey = ValueKey<String>('host-code-refresh');

/// Key of the loading indicator text.
const Key kHostCodeLoadingKey = ValueKey<String>('host-code-loading');

/// Key of the error text.
const Key kHostCodeErrorKey = ValueKey<String>('host-code-error');

/// Key of the expired-invite text.
const Key kHostCodeExpiryKey = ValueKey<String>('host-code-expiry');

/// Bounds a single invite mint: without this, a hung callable would hold
/// `_fetching` true forever and wedge the panel (no retries, stale QR).
const Duration kHostInviteFetchTimeout = Duration(seconds: 10);

/// Host panel: scoped invite QR + expiry + manual refresh.
///
/// Owns its mint: fetches immediately on open and re-evaluates expiry on a
/// 1s ticker while mounted. Pass a fake [HostInviteClient.invoker] in widget
/// tests; production passes the real Cloud Functions client.
class HostCodePanel extends StatefulWidget {
  /// Creates the host code panel.
  const HostCodePanel({
    super.key,
    required this.client,
    required this.onClose,
    this.onBack,
    this.primaryFocusNode,
    this.clock = const SystemClock(),
  });

  /// Host-only invite minter (authorization carries the TV's device id).
  final HostInviteClient client;

  /// Closes the whole overlay.
  final VoidCallback onClose;

  /// Returns to the recovery actions; null hides the back button.
  final VoidCallback? onBack;

  /// Focus node for the first action, so the D-pad lands inside the panel.
  final FocusNode? primaryFocusNode;

  /// Clock for expiry evaluation (injectable for deterministic tests).
  final Clock clock;

  @override
  State<HostCodePanel> createState() => _HostCodePanelState();
}

class _HostCodePanelState extends State<HostCodePanel> {
  HostInvite? _invite;
  String? _error;
  bool _firstFetchDone = false;
  bool _fetching = false;
  int _generation = 0;
  Timer? _expiryTimer;

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
    // Re-evaluates expiry only; never re-mints on its own (invites are
    // server-minted capabilities, not pollable state).
    _expiryTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) {
        return;
      }
      final HostInvite? invite = _invite;
      if (invite != null && invite.isExpired(widget.clock.now())) {
        setState(() {});
      }
    });
  }

  @override
  void dispose() {
    _generation++;
    _expiryTimer?.cancel();
    _expiryTimer = null;
    super.dispose();
  }

  bool get _expired {
    final HostInvite? invite = _invite;
    return invite != null && invite.isExpired(widget.clock.now());
  }

  Future<void> _refresh() async {
    if (_fetching || !mounted) {
      return;
    }
    _fetching = true;
    final int generation = _generation;
    try {
      final HostInvite invite = await widget.client.createInvite().timeout(
        kHostInviteFetchTimeout,
      );
      if (!mounted || generation != _generation) {
        return;
      }
      setState(() {
        _invite = invite;
        _error = null;
        _firstFetchDone = true;
      });
    } on TimeoutException {
      // A hung mint releases the in-flight guard so the next REFRESH
      // retries; the last valid invite (if any) is retained behind an
      // inline error.
      if (!mounted || generation != _generation) {
        return;
      }
      setState(() {
        _error = 'host invite refresh timed out';
        _firstFetchDone = true;
      });
    } on Object catch (error) {
      if (!mounted || generation != _generation) {
        return;
      }
      setState(() {
        _error = error is HostInviteException
            ? error.message
            : 'unexpected host invite failure';
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
              key: kHostCodePanelKey,
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
                    const Text('HOST QR', style: CctvTheme.labelStyle),
                    const SizedBox(height: 8),
                    const Text(
                      'On the companion app, open the host entry and scan '
                      'this code. Guests use GUEST CODES instead — the guest '
                      'PIN can never grant host access.',
                      style: TextStyle(color: Colors.white70, fontSize: 18),
                    ),
                    const SizedBox(height: 20),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: <Widget>[
                              const Text(
                                'HOST INVITE',
                                style: TextStyle(
                                  color: Color(0xFFFFC107),
                                  fontSize: 20,
                                ),
                              ),
                              const SizedBox(height: 4),
                              _sessionLine(),
                            ],
                          ),
                        ),
                        _qrBox(),
                      ],
                    ),
                    const SizedBox(height: 8),
                    _stateLine(),
                    const SizedBox(height: 20),
                    FocusTraversalGroup(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: <Widget>[
                          if (widget.onBack != null)
                            _PanelButton(
                              actionKey: kHostCodeBackKey,
                              label: 'BACK',
                              focusNode: widget.primaryFocusNode,
                              onPressed: widget.onBack!,
                            ),
                          if (widget.onBack != null) const SizedBox(height: 10),
                          _PanelButton(
                            actionKey: kHostCodeRefreshKey,
                            label: 'REFRESH',
                            focusNode: widget.onBack == null
                                ? widget.primaryFocusNode
                                : null,
                            onPressed: () => unawaited(_refresh()),
                          ),
                          const SizedBox(height: 10),
                          _PanelButton(
                            actionKey: kHostCodeCloseKey,
                            label: 'CLOSE',
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
    final HostInvite? invite = _invite;
    if (invite == null) {
      return Text(
        'party ${widget.client.partyId} · ${widget.client.channelId}',
        key: kHostCodeSessionKey,
        style: const TextStyle(color: Colors.white70, fontSize: 18),
      );
    }
    return Text(
      'party ${invite.partyId} · ${invite.channelId} · '
      'expires ${invite.expiresAt.toUtc().toIso8601String()}',
      key: kHostCodeSessionKey,
      style: const TextStyle(color: Colors.white70, fontSize: 18),
    );
  }

  /// Exactly one QR while a live, unexpired invite exists; no fabricated
  /// QR before the first successful mint, and the stale capability is
  /// hidden the moment it lapses.
  Widget _qrBox() {
    final HostInvite? invite = _invite;
    if (invite == null || _expired) {
      return Container(
        width: 204,
        height: 204,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          border: Border.all(color: CctvTheme.frameEdge),
        ),
        child: Text(
          _expired ? 'Invite expired — refresh.' : 'Waiting for invite…',
          textAlign: TextAlign.center,
          style: const TextStyle(color: Colors.white70, fontSize: 16),
        ),
      );
    }
    final String payload = buildHostJoinPayload(
      partyId: invite.partyId,
      channelId: invite.channelId,
      inviteToken: invite.inviteToken,
    );
    return Container(
      padding: const EdgeInsets.all(12),
      color: Colors.white,
      child: QrImageView(
        key: kHostCodeQrKey,
        data: payload,
        semanticsLabel: payload,
        size: 180,
        backgroundColor: Colors.white,
      ),
    );
  }

  Widget _stateLine() {
    if (!_firstFetchDone && _invite == null && _error == null) {
      return const Text(
        'Minting host invite…',
        key: kHostCodeLoadingKey,
        style: TextStyle(color: Colors.white70, fontSize: 22),
      );
    }
    // First mint failed with nothing valid to show: error, no QR.
    if (_invite == null && _error != null) {
      return Text(
        'Host invite unavailable: $_error',
        key: kHostCodeErrorKey,
        style: const TextStyle(color: Color(0xFFFFC107), fontSize: 22),
      );
    }
    if (_expired) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const Text(
            'Invite expired — refresh for a new code.',
            key: kHostCodeExpiryKey,
            style: TextStyle(color: Color(0xFFFFC107), fontSize: 22),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                'Refresh failed: $_error — showing last invite.',
                key: kHostCodeErrorKey,
                style: const TextStyle(color: Color(0xFFFFC107), fontSize: 18),
              ),
            ),
        ],
      );
    }
    if (_error != null) {
      return Text(
        'Refresh failed: $_error — showing last invite.',
        key: kHostCodeErrorKey,
        style: const TextStyle(color: Color(0xFFFFC107), fontSize: 18),
      );
    }
    return const SizedBox.shrink();
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
