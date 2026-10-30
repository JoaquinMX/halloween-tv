/// Shared connection status banner for the companion guest flow.
///
/// Maps [GuestSessionState] snapshots (plus the composition-root
/// `remoteUnavailableReason`) to sanitized, user-presentable status text.
/// Raw backend payloads, digests, and SDK messages never reach the UI: only
/// the curated [GuestSessionState.message] detail string is shown, and only
/// as supplementary detail under a fixed heading.
///
/// Covers: loading, missing configuration, no manifest, connection
/// failure/stale data, denied, expired, and malformed-data states. `ready`
/// renders nothing so the lineup owns the screen.
library;

import 'package:companion_app/src/session/guest_session_state.dart';
import 'package:flutter/material.dart';

/// Shared status widget for the join -> now-playing flow.
///
/// [state] is the current session snapshot. [unavailableReason] is the
/// composition-root `remoteUnavailableReason` (missing configuration) shown
/// while idle. [onRetry] wires the explicit retry affordance for the
/// recoverable cold/transient states; it is only rendered for
/// [GuestSessionStatus.unavailable] and [GuestSessionStatus.stale].
final class ConnectionStatus extends StatelessWidget {
  const ConnectionStatus({
    super.key,
    required this.state,
    this.unavailableReason,
    this.onRetry,
  });

  final GuestSessionState state;
  final String? unavailableReason;
  final Future<void> Function()? onRetry;

  /// Key of the retry affordance, when rendered.
  static const Key retryKey = Key('connection-retry');

  @override
  Widget build(BuildContext context) {
    final GuestSessionStatus status = state.status;
    if (status == GuestSessionStatus.ready) {
      return const SizedBox.shrink();
    }
    if (status == GuestSessionStatus.idle) {
      final String? reason = unavailableReason;
      if (reason == null || reason.isEmpty) {
        return const SizedBox.shrink();
      }
      return _card(
        status: status,
        heading: 'Backend is not configured.',
        detail: reason,
        showSpinner: false,
      );
    }
    switch (status) {
      case GuestSessionStatus.loading:
        return _card(
          status: status,
          heading: state.manifest == null
              ? 'Joining party…'
              : 'Refreshing lineup…',
          detail: state.message,
          showSpinner: true,
        );
      case GuestSessionStatus.unavailable:
        return _card(
          status: status,
          heading: 'No lineup available.',
          detail: state.message,
          showSpinner: false,
        );
      case GuestSessionStatus.stale:
        return _card(
          status: status,
          heading: 'Connection lost — showing last-known lineup.',
          detail: state.message,
          showSpinner: false,
        );
      case GuestSessionStatus.denied:
        return _card(
          status: status,
          heading: 'Access was denied.',
          detail: state.message,
          showSpinner: false,
        );
      case GuestSessionStatus.expired:
        return _card(
          status: status,
          heading: 'This lineup has expired.',
          detail: state.message,
          showSpinner: false,
        );
      case GuestSessionStatus.invalidData:
        return _card(
          status: status,
          heading: 'The lineup data was invalid.',
          detail: state.message,
          showSpinner: false,
        );
      case GuestSessionStatus.ready:
      case GuestSessionStatus.idle:
        return const SizedBox.shrink();
    }
  }

  Widget _card({
    required GuestSessionStatus status,
    required String heading,
    required String? detail,
    required bool showSpinner,
  }) {
    final bool offerRetry =
        onRetry != null &&
        (status == GuestSessionStatus.unavailable ||
            status == GuestSessionStatus.stale);
    return Card(
      key: Key('connection-status-${status.name}'),
      margin: const EdgeInsets.symmetric(vertical: 8),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Row(
              children: <Widget>[
                if (showSpinner) ...<Widget>[
                  const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  const SizedBox(width: 12),
                ],
                Expanded(
                  child: Text(
                    heading,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
            if (detail != null && detail.isNotEmpty) ...<Widget>[
              const SizedBox(height: 8),
              Text(detail, style: const TextStyle(fontSize: 16)),
            ],
            if (offerRetry) ...<Widget>[
              const SizedBox(height: 12),
              OutlinedButton(
                key: retryKey,
                onPressed: () {
                  final Future<void> Function()? retry = onRetry;
                  if (retry != null) {
                    retry();
                  }
                },
                child: const Text('Retry', style: TextStyle(fontSize: 18)),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
