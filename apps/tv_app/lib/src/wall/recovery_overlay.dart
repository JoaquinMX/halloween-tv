/// Hidden recovery panel (OK long-press / menu key).
library;

import 'package:core_ui/core_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Ops-style recovery panel for the wall.
///
/// Never shown by default: the wall reveals it on an OK long-press or the
/// remote's menu key. Actions are deliberately blunt (retry cached wall,
/// disable effects) so a TV can be rescued with a D-pad only.
class RecoveryOverlay extends StatelessWidget {
  /// Creates the overlay.
  const RecoveryOverlay({
    super.key,
    required this.effectsDisabled,
    required this.onRetryCached,
    required this.onToggleEffects,
    required this.onClose,
    this.primaryFocusNode,
    this.statusMessage,
  });

  /// Whether effects are currently disabled (drives the toggle label).
  final bool effectsDisabled;

  /// Retries the last cached wall manifest.
  final VoidCallback onRetryCached;

  /// Toggles CRT effect overlays on/off.
  final VoidCallback onToggleEffects;

  /// Closes the overlay.
  final VoidCallback onClose;

  /// Focus node for the first action; the wall focuses it when opening the
  /// panel so a remote's D-pad lands inside the overlay immediately.
  final FocusNode? primaryFocusNode;

  /// Optional inline status line (e.g. "no cached wall").
  final String? statusMessage;

  /// MENU closes the panel again, like it opens it.
  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is KeyDownEvent &&
        event.logicalKey == LogicalKeyboardKey.contextMenu) {
      onClose();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    return Focus(
      canRequestFocus: false,
      skipTraversal: true,
      onKeyEvent: _onKey,
      child: _panel(context),
    );
  }

  Widget _panel(BuildContext context) {
    return ColoredBox(
      color: const Color(0xE6000000),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: Container(
            padding: const EdgeInsets.all(28),
            decoration: BoxDecoration(
              color: const Color(0xFF101410),
              border: Border.all(color: CctvTheme.frameEdge, width: 2),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const Text('RECOVERY', style: CctvTheme.labelStyle),
                const SizedBox(height: 8),
                const Text(
                  'Wall running on local fixtures. OK long-press or MENU '
                  'opens this panel; arrows move, OK selects.',
                  style: TextStyle(color: Colors.white70, fontSize: 18),
                ),
                if (statusMessage != null) ...<Widget>[
                  const SizedBox(height: 8),
                  Text(
                    statusMessage!,
                    key: const ValueKey<String>('recovery-status'),
                    style: const TextStyle(
                      color: Color(0xFFFFC107),
                      fontSize: 18,
                    ),
                  ),
                ],
                const SizedBox(height: 20),
                FocusTraversalGroup(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      _RecoveryButton(
                        actionKey: const ValueKey<String>('recovery-retry'),
                        label: 'RETRY CACHED WALL',
                        focusNode: primaryFocusNode,
                        onPressed: onRetryCached,
                      ),
                      const SizedBox(height: 10),
                      _RecoveryButton(
                        actionKey: const ValueKey<String>(
                          'recovery-toggle-effects',
                        ),
                        label: effectsDisabled
                            ? 'ENABLE EFFECTS'
                            : 'DISABLE EFFECTS',
                        onPressed: onToggleEffects,
                      ),
                      const SizedBox(height: 10),
                      _RecoveryButton(
                        actionKey: const ValueKey<String>('recovery-close'),
                        label: 'CLOSE',
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
    );
  }
}

/// Large, TV-focusable action button.
class _RecoveryButton extends StatelessWidget {
  const _RecoveryButton({
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
