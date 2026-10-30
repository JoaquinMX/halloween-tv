/// Host-visible party code panel (D-pad settings overlay page).
///
/// Shows the TV's own party/device code as large text, a QR encoding the
/// anonymous join payload (opaque identifiers only — never URLs or secrets),
/// and the per-guest device codes the host dictates verbally. Pure display:
/// the guest list arrives via constructor props, so this widget never
/// touches Firebase and stays hermetic in widget tests.
library;

import 'package:core_ui/core_ui.dart';
import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

import 'package:tv_app/src/wall/guest_codes.dart';

/// Key of the guest code panel.
const Key kGuestCodePanelKey = ValueKey<String>('guest-code-panel');

/// Key of the guest-code close button.
const Key kGuestCodeCloseKey = ValueKey<String>('guest-code-close');

/// Key of the guest-code back button (returns to the recovery actions).
const Key kGuestCodeBackKey = ValueKey<String>('guest-code-back');

/// Host panel: TV code (large text + QR) and the guest code list.
class GuestCodePanel extends StatelessWidget {
  /// Creates the host code panel.
  const GuestCodePanel({
    super.key,
    required this.partyId,
    required this.tvDeviceId,
    required this.channelId,
    required this.joinPayload,
    required this.guests,
    required this.isLoadingGuests,
    required this.onClose,
    this.guestsError,
    this.onBack,
    this.primaryFocusNode,
  });

  /// Party the TV belongs to.
  final String partyId;

  /// TV's own device code, shown as large text.
  final String tvDeviceId;

  /// Active channel.
  final String channelId;

  /// QR payload: JSON join object with opaque identifiers only.
  final String joinPayload;

  /// Guest codes, or null when not loaded.
  final List<GuestCodeEntry>? guests;

  /// True while the guest list is loading.
  final bool isLoadingGuests;

  /// Closes the whole overlay.
  final VoidCallback onClose;

  /// Guest-list read failure, shown inline; null when none.
  final String? guestsError;

  /// Returns to the recovery actions; null hides the back button.
  final VoidCallback? onBack;

  /// Focus node for the first action, so the D-pad lands inside the panel.
  final FocusNode? primaryFocusNode;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
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
                    'Host reads codes aloud — guests type them in '
                    '"Halloween TV - Guests". QR scan lands in a later slice.',
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
                              'TV CODE',
                              style: TextStyle(
                                color: Color(0xFFFFC107),
                                fontSize: 20,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              tvDeviceId,
                              style: const TextStyle(
                                color: Colors.white,
                                fontSize: 44,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                            const SizedBox(height: 8),
                            Text(
                              'party $partyId · $channelId',
                              style: const TextStyle(
                                color: Colors.white70,
                                fontSize: 18,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.all(12),
                        color: Colors.white,
                        child: QrImageView(
                          data: joinPayload,
                          size: 180,
                          backgroundColor: Colors.white,
                        ),
                      ),
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
                        if (onBack != null)
                          _PanelButton(
                            actionKey: kGuestCodeBackKey,
                            label: 'BACK',
                            focusNode: primaryFocusNode,
                            onPressed: onBack!,
                          ),
                        if (onBack != null) const SizedBox(height: 10),
                        _PanelButton(
                          actionKey: kGuestCodeCloseKey,
                          label: 'CLOSE',
                          focusNode: onBack == null ? primaryFocusNode : null,
                          onPressed: onClose,
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
    );
  }

  Widget _guestListBody() {
    if (isLoadingGuests) {
      return const Text(
        'Loading guest codes…',
        style: TextStyle(color: Colors.white70, fontSize: 22),
      );
    }
    if (guestsError != null) {
      return Text(
        'Guest list unavailable: $guestsError',
        style: const TextStyle(color: Color(0xFFFFC107), fontSize: 22),
      );
    }
    final List<GuestCodeEntry>? rows = guests;
    if (rows == null || rows.isEmpty) {
      return const Text(
        'No guest codes yet — run seed_guests, then reopen this panel.',
        style: TextStyle(color: Colors.white70, fontSize: 22),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        for (final GuestCodeEntry entry in rows)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Text(
              '${entry.label}: ${entry.deviceId}',
              style: const TextStyle(color: Colors.white, fontSize: 26),
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
