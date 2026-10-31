/// Read-only now-playing lineup for the companion guest flow.
///
/// Renders the party's latest published lineup from a [GuestSessionState]
/// snapshot: only the cameras present in the valid 1/2/4-camera manifest, in
/// canonical [cctvSlots] wall order (labels via [resolveCctvLabel]), the
/// manifest version, the server publication timestamp
/// ([PlaybackManifest.publishedAt]), and the separately labeled
/// last-successful-check time with an explicit timezone.
///
/// This is a read-only companion view of published data. It makes NO claim
/// about TV playback sync: nothing here plays media or tracks what any
/// screen is showing.
///
/// Refresh/Retry stay explicit with the caller ([onRefresh]); [onLeave]
/// leaves the party and resets the flow.
library;

import 'package:companion_app/src/session/guest_session_state.dart';
import 'package:companion_app/src/ui/connection_status.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:core_ui/core_ui.dart' show CctvTheme;
import 'package:flutter/material.dart';

/// Read-only lineup view driven by a session snapshot.
final class NowPlayingScreen extends StatelessWidget {
  const NowPlayingScreen({
    super.key,
    required this.state,
    required this.onRefresh,
    required this.onLeave,
    this.onGuestPhoto,
  });

  final GuestSessionState state;
  final Future<void> Function() onRefresh;
  final Future<void> Function() onLeave;
  final VoidCallback? onGuestPhoto;

  static const Key refreshKey = Key('now-playing-refresh');
  static const Key retryKey = Key('now-playing-retry');
  static const Key leaveKey = Key('now-playing-leave');

  static String formatUtc(DateTime value) =>
      '${value.toUtc().toIso8601String()} (UTC)';

  @override
  Widget build(BuildContext context) {
    final GuestSessionState snapshot = state;
    final PlaybackManifest? manifest = snapshot.manifest;
    final bool showRetry =
        snapshot.status == GuestSessionStatus.stale ||
        snapshot.status == GuestSessionStatus.unavailable;
    return Scaffold(
      appBar: AppBar(title: const Text('Now playing')),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 720),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const Text(
                  "The party's latest published lineup",
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 8),
                const Text(
                  'Read-only companion view of the published lineup. '
                  'It does not reflect what any screen is showing.',
                  style: TextStyle(fontSize: 18),
                ),
                const SizedBox(height: 8),
                ConnectionStatus(
                  state: snapshot,
                  onRetry: showRetry ? onRefresh : null,
                ),
                if (manifest != null) ...<Widget>[
                  const SizedBox(height: 8),
                  Text(
                    'Manifest version ${manifest.version}',
                    style: const TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Server publication time: '
                    '${formatUtc(manifest.publishedAt)}',
                    style: CctvTheme.timestampStyle.copyWith(fontSize: 18),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    snapshot.lastSuccessfulCheck == null
                        ? 'Last successful check: not yet confirmed'
                        : 'Last successful check: '
                              '${formatUtc(snapshot.lastSuccessfulCheck!)}',
                    style: CctvTheme.timestampStyle.copyWith(fontSize: 18),
                  ),
                  const SizedBox(height: 16),
                  // Reduced layouts (1/2 cameras) render only the cameras
                  // present in the valid manifest, in canonical wall order —
                  // never placeholder tiles for absent cameras.
                  ..._presentSlots(manifest).map(
                    (CctvSlot slot) =>
                        _cameraTile(manifest: manifest, slot: slot),
                  ),
                ],
                const SizedBox(height: 20),
                Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: <Widget>[
                    ElevatedButton(
                      key: refreshKey,
                      onPressed: () {
                        onRefresh();
                      },
                      child: const Text(
                        'Refresh',
                        style: TextStyle(fontSize: 20),
                      ),
                    ),
                    if (showRetry)
                      OutlinedButton(
                        key: retryKey,
                        onPressed: () {
                          onRefresh();
                        },
                        child: const Text(
                          'Retry',
                          style: TextStyle(fontSize: 20),
                        ),
                      ),
                    if (onGuestPhoto != null)
                      OutlinedButton(
                        onPressed: onGuestPhoto,
                        child: const Text(
                          'Submit a guest photo',
                          style: TextStyle(fontSize: 20),
                        ),
                      ),
                    OutlinedButton(
                      key: leaveKey,
                      onPressed: () {
                        onLeave();
                      },
                      child: const Text(
                        'Leave',
                        style: TextStyle(fontSize: 20),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// Cameras present in [manifest], in canonical wall order.
  ///
  /// Validated 1/2/4-camera manifests carry the first-N canonical slots, so
  /// filtering [cctvSlots] by presence renders each layout without
  /// placeholder tiles for absent cameras.
  List<CctvSlot> _presentSlots(PlaybackManifest manifest) {
    final Set<String> present = <String>{
      for (final ClipDescriptor clip in manifest.clips) clip.cameraId,
    };
    return <CctvSlot>[
      for (final CctvSlot slot in cctvSlots)
        if (present.contains(slot.id)) slot,
    ];
  }

  Widget _cameraTile({
    required PlaybackManifest manifest,
    required CctvSlot slot,
  }) {
    ClipDescriptor? match;
    for (final ClipDescriptor clip in manifest.clips) {
      if (clip.cameraId == slot.id) {
        match = clip;
        break;
      }
    }
    final String label = match == null
        ? slot.defaultLabel
        : resolveCctvLabel(match);
    return Card(
      key: Key('camera-${slot.id}'),
      margin: const EdgeInsets.symmetric(vertical: 6),
      child: ListTile(
        title: Text(label, style: CctvTheme.labelStyle.copyWith(fontSize: 20)),
        subtitle: Text(
          match == null ? 'No clip published' : 'Clip ${match.id}',
          style: const TextStyle(fontSize: 16),
        ),
      ),
    );
  }
}
