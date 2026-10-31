/// Dedicated host entry screen: Scan Host QR + explicit Join-as-guest route.
///
/// Rationale (navigation decision): guest PIN admission is intentionally
/// broad — anyone who can see the TV screen can self-register as a guest —
/// so host administration must never be reachable through the guest PIN or a
/// client-supplied role string. A dedicated entry screen keeps the two
/// routes visibly distinct and makes the privilege boundary auditable: the
/// host QR carries a server-minted, short-lived invite capability redeemed
/// through `joinHost` for a separate phone identity with the server-assigned
/// host role, while the guest route carries only the display PIN redeemed
/// through `joinParty`. Scan and paste funnel through the same shared
/// [parseGuestJoinPayload] validator (parity), and only host-typed payloads
/// are redeemed here — anything else fails visibly without network traffic.
library;

import 'package:companion_app/src/join/device_identity_store.dart';
import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:companion_app/src/join/join_payload_scanner.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:flutter/material.dart';

final class HostEntryScreen extends StatefulWidget {
  const HostEntryScreen({
    super.key,
    required this.onHostJoin,
    required this.onJoinAsGuest,
    this.configurationIssue,
    this.identityStore,
    this.scanner = const UnavailableJoinPayloadScanner(),
  });

  /// Redeems a validated host payload. Throws a sanitized message on
  /// denial so the failure stays visible on this screen.
  final Future<void> Function(GuestJoinData data) onHostJoin;

  /// Explicit guest route: shows the anonymous guest join form.
  final VoidCallback onJoinAsGuest;

  final String? configurationIssue;
  final DeviceIdentityStore? identityStore;
  final JoinPayloadScanner scanner;

  static const Key payloadFieldKey = Key('host-entry-payload');
  static const Key submitKey = Key('host-entry-submit');
  static const Key errorKey = Key('host-entry-error');
  static const Key scanKey = Key('host-entry-scan');
  static const Key joinAsGuestKey = Key('host-entry-join-as-guest');

  @override
  State<HostEntryScreen> createState() => _HostEntryScreenState();
}

final class _HostEntryScreenState extends State<HostEntryScreen> {
  final _payload = TextEditingController();
  late final DeviceIdentityStore _identityStore =
      widget.identityStore ?? DeviceIdentityStore();
  String? _hostDeviceId;
  String? _error;
  bool _submitting = false;
  bool _scanning = false;

  @override
  void initState() {
    super.initState();
    _initialize();
  }

  Future<void> _initialize() async {
    try {
      final id = await _identityStore.getHostDeviceId();
      if (mounted) setState(() => _hostDeviceId = id);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'Could not save this host device identity. Retry to continue.',
        );
      }
    }
  }

  @override
  void dispose() {
    _payload.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_submitting || _hostDeviceId == null) return;
    final pasted = _payload.text.trim();
    if (pasted.isEmpty) {
      setState(() => _error = 'Paste a host invitation or scan a Host QR.');
      return;
    }
    final Result<GuestJoinData> result = parseGuestJoinPayload(
      pasted,
      localDeviceId: _hostDeviceId!,
    );
    switch (result) {
      case Ok(:final GuestJoinData value):
        if (value.role != JoinRole.host) {
          setState(
            () => _error =
                'This is a guest invitation. Use “Join as guest” below '
                'instead — host entry needs a Host QR.',
          );
          return;
        }
        setState(() {
          _error = null;
          _submitting = true;
        });
        try {
          await widget.onHostJoin(value);
        } on Object catch (error) {
          if (mounted) setState(() => _error = '$error');
        } finally {
          if (mounted) setState(() => _submitting = false);
        }
      case Err(:final String message):
        setState(() => _error = message);
    }
  }

  Future<void> _scan() async {
    if (_scanning || _submitting || _hostDeviceId == null) return;
    setState(() => _scanning = true);
    try {
      // This State's context lives below the app's MaterialApp, so the
      // scanner's route push resolves a real Navigator. Never retain the
      // context beyond the future.
      final result = await widget.scanner.scan(context);
      if (!mounted) return;
      if (result case JoinPayloadText(:final text)) {
        setState(() => _payload.text = text);
        await _submit();
      } else if (result case JoinPayloadPermissionDenied(:final permanently)) {
        setState(
          () => _error = permanently
              ? 'Camera access is off. Allow camera access in Settings to scan Host QR codes, or paste the invitation instead.'
              : 'Camera permission is needed to scan Host QR codes. Allow access and try again, or paste the invitation instead.',
        );
      } else {
        setState(() => _error = 'Scanner is unavailable on this device.');
      }
    } finally {
      if (mounted) setState(() => _scanning = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Halloween TV — Host entry')),
    body: Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Text(
                'Scan the Host QR shown on the organizer TV, or paste the '
                'host invitation. Host access is a separate short-lived '
                'invite — a guest PIN can never open it.',
                style: TextStyle(fontSize: 18),
              ),
              if (widget.configurationIssue?.isNotEmpty == true)
                Text('Backend is not configured: ${widget.configurationIssue}'),
              const SizedBox(height: 16),
              TextField(
                key: HostEntryScreen.payloadFieldKey,
                controller: _payload,
                decoration: const InputDecoration(
                  labelText: 'Host invitation (paste or scan)',
                  hintText:
                      '{"partyId":"…","channelId":"…","role":"host",'
                      '"inviteToken":"hi-…"}',
                  border: OutlineInputBorder(),
                ),
                minLines: 1,
                maxLines: 4,
                autocorrect: false,
                enableSuggestions: false,
              ),
              TextButton(
                key: HostEntryScreen.scanKey,
                onPressed: _hostDeviceId == null || _submitting || _scanning
                    ? null
                    : _scan,
                child: const Text('Scan Host QR'),
              ),
              if (_error != null)
                Text(
                  _error!,
                  key: HostEntryScreen.errorKey,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              const SizedBox(height: 16),
              ElevatedButton(
                key: HostEntryScreen.submitKey,
                onPressed: _hostDeviceId == null || _submitting
                    ? null
                    : _submit,
                child: _submitting
                    ? const CircularProgressIndicator()
                    : const Text('Join as host'),
              ),
              const SizedBox(height: 8),
              OutlinedButton(
                key: HostEntryScreen.joinAsGuestKey,
                onPressed: widget.onJoinAsGuest,
                child: const Text('Join as guest'),
              ),
              if (_hostDeviceId == null) const Text('Preparing this device…'),
            ],
          ),
        ),
      ),
    ),
  );
}
