import 'package:channel_api/channel_api.dart';
import 'package:flutter/widgets.dart';

/// Placeholder plugin proving reuse of the channel API.
class RetroTvChannelPlugin implements ChannelPlugin {
  const RetroTvChannelPlugin();

  @override
  ChannelDescriptor get descriptor =>
      const ChannelDescriptor('retro.tv', 'Retro Horror Channel', '0.1.0');

  @override
  Widget buildEntry(ChannelContext context) {
    return const Center(child: Text('Retro Horror Channel coming soon'));
  }
}
