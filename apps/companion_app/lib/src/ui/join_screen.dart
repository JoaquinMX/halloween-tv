/// Manual guest join form: party/device/channel fields plus an optional
/// pasted join-data field.
///
/// Identifiers are parsed through the real p3 parsers
/// ([parseGuestJoinFields] for manual entry, [parseGuestJoinPayload] for
/// pasted JSON). Well-formed only — never proof of registration: the server
/// still decides access at manifest-read time. Validation and parse failures
/// render inline as the invalid-data state; the [onJoin] callback fires only
/// for well-formed [GuestJoinData].
///
/// No Firebase Auth, no registration, no network traffic here.
library;

import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:flutter/material.dart';

/// Manual join form. Calls [onJoin] exactly once per successful parse.
final class JoinScreen extends StatefulWidget {
  const JoinScreen({super.key, required this.onJoin, this.configurationIssue});

  /// Invoked with well-formed join identifiers (never with invalid input).
  final Future<void> Function(GuestJoinData data) onJoin;

  /// Composition-root configuration problem shown as a banner, if any.
  final String? configurationIssue;

  static const Key partyFieldKey = Key('join-party-id');
  static const Key deviceFieldKey = Key('join-device-id');
  static const Key channelFieldKey = Key('join-channel-id');
  static const Key payloadFieldKey = Key('join-payload');
  static const Key submitKey = Key('join-submit');
  static const Key errorKey = Key('join-error');

  @override
  State<JoinScreen> createState() => _JoinScreenState();
}

final class _JoinScreenState extends State<JoinScreen> {
  final TextEditingController _party = TextEditingController();
  final TextEditingController _device = TextEditingController();
  final TextEditingController _channel = TextEditingController();
  final TextEditingController _payload = TextEditingController();
  String? _error;
  bool _submitting = false;

  @override
  void dispose() {
    _party.dispose();
    _device.dispose();
    _channel.dispose();
    _payload.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_submitting) {
      return;
    }
    final String pasted = _payload.text.trim();
    final Result<GuestJoinData> result = pasted.isEmpty
        ? parseGuestJoinFields(
            partyId: _party.text,
            deviceId: _device.text,
            channelId: _channel.text,
          )
        : parseGuestJoinPayload(pasted);
    switch (result) {
      case Ok(:final GuestJoinData value):
        setState(() {
          _error = null;
          _submitting = true;
        });
        try {
          await widget.onJoin(value);
        } finally {
          if (mounted) {
            setState(() {
              _submitting = false;
            });
          }
        }
      case Err(:final String message):
        setState(() {
          _error = message;
        });
    }
  }

  @override
  Widget build(BuildContext context) {
    final String? configurationIssue = widget.configurationIssue;
    return Scaffold(
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
                  'Ask the organizer for the party ID, device ID, and '
                  'channel ID, then enter them below. Entering identifiers '
                  'only checks they are well-formed; the party server '
                  'decides whether this device may join.',
                  style: TextStyle(fontSize: 18),
                ),
                const SizedBox(height: 16),
                if (configurationIssue != null &&
                    configurationIssue.isNotEmpty) ...<Widget>[
                  Card(
                    key: const Key('join-config-banner'),
                    margin: EdgeInsets.zero,
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Text(
                        'Backend is not configured: $configurationIssue',
                        style: const TextStyle(fontSize: 16),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                ],
                TextField(
                  key: JoinScreen.partyFieldKey,
                  controller: _party,
                  decoration: const InputDecoration(
                    labelText: 'Party ID',
                    hintText: 'e.g. haunted-house-1',
                    border: OutlineInputBorder(),
                  ),
                  style: const TextStyle(fontSize: 18),
                  textInputAction: TextInputAction.next,
                  autocorrect: false,
                  enableSuggestions: false,
                ),
                const SizedBox(height: 12),
                TextField(
                  key: JoinScreen.deviceFieldKey,
                  controller: _device,
                  decoration: const InputDecoration(
                    labelText: 'Device ID',
                    hintText: 'e.g. guest-phone-7',
                    border: OutlineInputBorder(),
                  ),
                  style: const TextStyle(fontSize: 18),
                  textInputAction: TextInputAction.next,
                  autocorrect: false,
                  enableSuggestions: false,
                ),
                const SizedBox(height: 12),
                TextField(
                  key: JoinScreen.channelFieldKey,
                  controller: _channel,
                  decoration: const InputDecoration(
                    labelText: 'Channel ID',
                    hintText: 'e.g. cctv',
                    border: OutlineInputBorder(),
                  ),
                  style: const TextStyle(fontSize: 18),
                  textInputAction: TextInputAction.next,
                  autocorrect: false,
                  enableSuggestions: false,
                ),
                const SizedBox(height: 12),
                TextField(
                  key: JoinScreen.payloadFieldKey,
                  controller: _payload,
                  decoration: const InputDecoration(
                    labelText: 'Pasted join data (optional)',
                    hintText:
                        '{"partyId": "…", "deviceId": "…", "channelId": "…"}',
                    border: OutlineInputBorder(),
                    helperText:
                        'Paste the JSON object from the organizer instead '
                        'of typing the fields above.',
                    helperMaxLines: 3,
                  ),
                  style: const TextStyle(fontSize: 16),
                  textInputAction: TextInputAction.done,
                  minLines: 1,
                  maxLines: 4,
                  autocorrect: false,
                  enableSuggestions: false,
                  onSubmitted: (_) => _submit(),
                ),
                if (_error != null) ...<Widget>[
                  const SizedBox(height: 12),
                  Text(
                    _error!,
                    key: JoinScreen.errorKey,
                    style: TextStyle(
                      fontSize: 16,
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ],
                const SizedBox(height: 20),
                ElevatedButton(
                  key: JoinScreen.submitKey,
                  onPressed: _submitting ? null : _submit,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: _submitting
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Join', style: TextStyle(fontSize: 20)),
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
