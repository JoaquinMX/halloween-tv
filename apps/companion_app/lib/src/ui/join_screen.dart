/// Anonymous party join form backed by a persisted local phone identity.
library;

import 'package:companion_app/src/join/device_identity_store.dart';
import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:companion_app/src/join/join_payload_scanner.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:flutter/material.dart';

final class JoinScreen extends StatefulWidget {
  const JoinScreen({
    super.key,
    required this.onJoin,
    this.configurationIssue,
    this.identityStore,
    this.scanner = const UnavailableJoinPayloadScanner(),
  });
  final Future<void> Function(GuestJoinData data) onJoin;
  final String? configurationIssue;
  final DeviceIdentityStore? identityStore;
  final JoinPayloadScanner scanner;
  static const Key partyFieldKey = Key('join-party-id');
  static const Key channelFieldKey = Key('join-channel-id');
  static const Key pinFieldKey = Key('join-pin');
  static const Key payloadFieldKey = Key('join-payload');
  static const Key submitKey = Key('join-submit');
  static const Key errorKey = Key('join-error');
  static const Key scanKey = Key('join-scan');
  @override
  State<JoinScreen> createState() => _JoinScreenState();
}

final class _JoinScreenState extends State<JoinScreen> {
  final _party = TextEditingController(),
      _channel = TextEditingController(),
      _pin = TextEditingController(),
      _payload = TextEditingController();
  late final DeviceIdentityStore _identityStore =
      widget.identityStore ?? DeviceIdentityStore();
  String? _deviceId, _error;
  bool _submitting = false, _scanning = false;
  @override
  void initState() {
    super.initState();
    _initialize();
  }

  Future<void> _initialize() async {
    try {
      final id = await _identityStore.getDeviceId();
      if (mounted) setState(() => _deviceId = id);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'Could not save this device identity. Retry to continue.',
        );
      }
    }
  }

  @override
  void dispose() {
    _party.dispose();
    _channel.dispose();
    _pin.dispose();
    _payload.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_submitting || _deviceId == null) return;
    final pasted = _payload.text.trim();
    final Result<GuestJoinData> result = pasted.isEmpty
        ? parseGuestJoinFields(
            partyId: _party.text,
            localDeviceId: _deviceId!,
            channelId: _channel.text,
            joinPin: _pin.text,
          )
        : parseGuestJoinPayload(pasted, localDeviceId: _deviceId!);
    switch (result) {
      case Ok(:final GuestJoinData value):
        setState(() {
          _error = null;
          _submitting = true;
        });
        try {
          await widget.onJoin(value);
        } finally {
          if (mounted) setState(() => _submitting = false);
        }
      case Err(:final String message):
        setState(() => _error = message);
    }
  }

  Future<void> _scan() async {
    if (_scanning || _submitting || _deviceId == null) return;
    setState(() => _scanning = true);
    try {
      // This State's context lives below the app's MaterialApp, so the
      // scanner's route push resolves a real Navigator. Never pass an
      // ancestor context captured above MaterialApp.
      final result = await widget.scanner.scan(context);
      if (!mounted) return;
      if (result case JoinPayloadText(:final text)) {
        setState(() => _payload.text = text);
        await _submit();
      } else if (result case JoinPayloadPermissionDenied(:final permanently)) {
        setState(
          () => _error = permanently
              ? 'Camera access is off. Allow camera access in Settings to scan QR codes, or paste the join data instead.'
              : 'Camera permission is needed to scan QR codes. Allow access and try again, or paste the join data instead.',
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
    appBar: AppBar(title: const Text('Join party')),
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
                'Enter the party and channel details from the organizer. The party server decides whether this device may join.',
                style: TextStyle(fontSize: 18),
              ),
              if (widget.configurationIssue?.isNotEmpty == true)
                Text('Backend is not configured: ${widget.configurationIssue}'),
              const SizedBox(height: 16),
              _field(JoinScreen.partyFieldKey, _party, 'Party ID'),
              const SizedBox(height: 12),
              _field(JoinScreen.channelFieldKey, _channel, 'Channel ID'),
              const SizedBox(height: 12),
              _field(JoinScreen.pinFieldKey, _pin, 'Join PIN (optional)'),
              const SizedBox(height: 12),
              TextField(
                key: JoinScreen.payloadFieldKey,
                controller: _payload,
                decoration: const InputDecoration(
                  labelText: 'Pasted join data (optional)',
                  hintText:
                      '{"partyId":"…","channelId":"…","joinPin":"004201"}',
                  border: OutlineInputBorder(),
                ),
                minLines: 1,
                maxLines: 4,
                autocorrect: false,
                enableSuggestions: false,
              ),
              TextButton(
                key: JoinScreen.scanKey,
                onPressed: _deviceId == null || _submitting || _scanning
                    ? null
                    : _scan,
                child: const Text('Scan QR'),
              ),
              if (_error != null)
                Text(
                  _error!,
                  key: JoinScreen.errorKey,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              const SizedBox(height: 16),
              ElevatedButton(
                key: JoinScreen.submitKey,
                onPressed: _deviceId == null || _submitting ? null : _submit,
                child: _submitting
                    ? const CircularProgressIndicator()
                    : const Text('Join'),
              ),
              if (_deviceId == null) const Text('Preparing this device…'),
            ],
          ),
        ),
      ),
    ),
  );
  Widget _field(Key key, TextEditingController controller, String label) =>
      TextField(
        key: key,
        controller: controller,
        decoration: InputDecoration(
          labelText: label,
          border: const OutlineInputBorder(),
        ),
        autocorrect: false,
        enableSuggestions: false,
      );
}
