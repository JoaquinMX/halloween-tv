/// Host administration panel: server-backed seed catalog.
///
/// Lists seed entries and camera videos across every backend state (empty,
/// queued, generating/running, ready, failed, expired, deleted). Generate
/// enqueues the supported fixed preset with a stable idempotency key per
/// seed id (retries reuse the queued job). Delete invokes the backend
/// operation and reconciles the list only after authoritative success —
/// failures leave the list untouched so they stay retryable. Deletion
/// granularity is per selected seed id: the seed entries and their
/// associated preview + delivery objects are removed, an affected current
/// manifest is revoked, and accounting records are preserved (server-side).
///
/// Polling and preview playback suspend on background/leave through the
/// owning [HostSession] (driven by the app lifecycle observer); stale
/// responses from another party or role never update this panel because the
/// session generation counter drops them before [HostSessionState] emits.
library;

import 'dart:async';

import 'package:companion_app/src/data/host_media_client.dart';
import 'package:companion_app/src/session/host_session.dart';
import 'package:flutter/material.dart';

/// Human-readable status labels for the seed lifecycle.
String hostSeedStatusLabel(String status) => switch (status) {
  'queued' => 'Queued',
  'running' => 'Generating',
  'ready' => 'Ready',
  'failed' => 'Failed',
  'deleted' => 'Deleted',
  'expired' => 'Expired',
  _ => status,
};

final class HostPanelScreen extends StatefulWidget {
  const HostPanelScreen({
    super.key,
    required this.session,
    required this.onLeave,
    required this.onPreview,
    this.onPhoto,
  });

  final HostSession session;

  /// Leaves the host session (stops polling, clears identity + catalog).
  final Future<void> Function() onLeave;

  /// Opens the preview for [seedId] (fresh scoped capability per view).
  final void Function(String seedId) onPreview;

  /// Opens the optional source-photo flow, when a photo client is wired.
  /// Null hides the entry point.
  final VoidCallback? onPhoto;

  static const Key listKey = Key('host-panel-list');
  static const Key emptyKey = Key('host-panel-empty');
  static const Key generateSeedKey = Key('host-panel-generate-seed');
  static const Key generateKey = Key('host-panel-generate');
  static const Key retryKey = Key('host-panel-retry');
  static const Key leaveKey = Key('host-panel-leave');
  static const Key messageKey = Key('host-panel-message');
  static Key deleteKey(String seedId) => Key('host-delete-$seedId');
  static Key viewKey(String seedId) => Key('host-view-$seedId');

  @override
  State<HostPanelScreen> createState() => _HostPanelScreenState();
}

final class _HostPanelScreenState extends State<HostPanelScreen> {
  final TextEditingController _seedId = TextEditingController();
  StreamSubscription<HostSessionState>? _states;
  bool _working = false;
  String? _actionError;
  final Set<String> _busySeeds = <String>{};

  @override
  void initState() {
    super.initState();
    _states = widget.session.states.listen((_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _states?.cancel();
    _seedId.dispose();
    super.dispose();
  }

  Future<void> _generate() async {
    if (_working) return;
    final String seedId = _seedId.text.trim();
    if (seedId.isEmpty) {
      setState(() => _actionError = 'Enter a seed id to generate.');
      return;
    }
    setState(() {
      _working = true;
      _actionError = null;
    });
    try {
      await widget.session.generate(seedId);
    } on Object catch (error) {
      if (mounted) setState(() => _actionError = '$error');
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _delete(String seedId) async {
    if (_busySeeds.contains(seedId)) return;
    setState(() {
      _busySeeds.add(seedId);
      _actionError = null;
    });
    try {
      await widget.session.deleteVideos(<String>[seedId]);
    } on Object catch (error) {
      if (mounted) setState(() => _actionError = '$error');
    } finally {
      if (mounted) {
        setState(() => _busySeeds.remove(seedId));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final HostSessionState snapshot = widget.session.state;
    return Scaffold(
      appBar: AppBar(title: const Text('Host panel')),
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
                  'Seed catalog for this party and channel',
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800),
                ),
                if (snapshot.status == HostSessionStatus.stale)
                  const Text('Connection lost — showing last-known catalog.'),
                if (_actionError != null)
                  Text(
                    _actionError!,
                    key: HostPanelScreen.messageKey,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                const SizedBox(height: 8),
                _body(snapshot),
                const SizedBox(height: 20),
                Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: <Widget>[
                    if (snapshot.status == HostSessionStatus.ready ||
                        snapshot.status == HostSessionStatus.stale) ...<Widget>[
                      ElevatedButton(
                        key: HostPanelScreen.retryKey,
                        onPressed: () {
                          widget.session.refresh();
                        },
                        child: const Text('Refresh'),
                      ),
                      if (widget.onPhoto != null)
                        OutlinedButton(
                          onPressed: widget.onPhoto,
                          child: const Text('Attach source photo'),
                        ),
                    ],
                    OutlinedButton(
                      key: HostPanelScreen.leaveKey,
                      onPressed: () {
                        widget.onLeave();
                      },
                      child: const Text('Leave'),
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

  Widget _body(HostSessionState snapshot) {
    switch (snapshot.status) {
      case HostSessionStatus.idle:
        return const Text('Not joined as host.');
      case HostSessionStatus.loading:
        return const Center(child: CircularProgressIndicator());
      case HostSessionStatus.denied:
        return Text(
          snapshot.message ?? 'Access was denied.',
          key: HostPanelScreen.messageKey,
        );
      case HostSessionStatus.unavailable:
      case HostSessionStatus.invalidData:
        return Text(
          snapshot.message ?? 'Could not load the catalog.',
          key: HostPanelScreen.messageKey,
        );
      case HostSessionStatus.ready:
      case HostSessionStatus.stale:
        return Column(
          key: HostPanelScreen.listKey,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            _generateRow(),
            const SizedBox(height: 12),
            if (snapshot.videos.isEmpty)
              const Text(
                'No seed videos yet. Generate the first entry above.',
                key: HostPanelScreen.emptyKey,
              )
            else
              ...snapshot.videos.map(_seedTile),
          ],
        );
    }
  }

  Widget _generateRow() => Row(
    children: <Widget>[
      Expanded(
        child: TextField(
          key: HostPanelScreen.generateSeedKey,
          controller: _seedId,
          decoration: const InputDecoration(
            labelText: 'New seed id',
            border: OutlineInputBorder(),
          ),
          autocorrect: false,
          enableSuggestions: false,
        ),
      ),
      const SizedBox(width: 12),
      ElevatedButton(
        key: HostPanelScreen.generateKey,
        onPressed: _working ? null : _generate,
        child: _working
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Text('Generate'),
      ),
    ],
  );

  Widget _seedTile(HostSeedVideo video) {
    final bool busy = _busySeeds.contains(video.seedId);
    final bool deleted = video.status == 'deleted';
    return Card(
      key: Key('host-seed-${video.seedId}'),
      margin: const EdgeInsets.symmetric(vertical: 6),
      child: ListTile(
        title: Text(
          '${video.seedId} · ${hostSeedStatusLabel(video.status)}',
          style: const TextStyle(fontSize: 20),
        ),
        subtitle: Text(
          deleted
              ? 'Deleted seed entry (tombstoned; previews will not return)'
              : 'Job ${video.jobId} · cameras ${video.cameraIds.join(", ")}'
                    '${video.previewAvailable ? " · preview ready" : ""}',
          style: const TextStyle(fontSize: 16),
        ),
        trailing: deleted || busy
            ? null
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  TextButton(
                    key: HostPanelScreen.viewKey(video.seedId),
                    onPressed: () => widget.onPreview(video.seedId),
                    child: const Text('View'),
                  ),
                  TextButton(
                    key: HostPanelScreen.deleteKey(video.seedId),
                    onPressed: () => _delete(video.seedId),
                    child: const Text('Delete'),
                  ),
                ],
              ),
      ),
    );
  }
}
