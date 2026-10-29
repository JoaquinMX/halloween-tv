/// Name-only retro-horror stub plugin.
library;

import 'package:channel_api/channel_api.dart';
import 'package:flutter/widgets.dart';

/// Channel id for the retro-horror placeholder.
const String retroHorrorChannelId = 'retro_horror';

/// Placeholder channel: builds a static page and never touches the wall.
final class RetroHorrorPlugin implements ChannelPlugin {
  /// Creates the stub.
  const RetroHorrorPlugin();

  @override
  ChannelDescriptor get descriptor => const ChannelDescriptor(
        id: retroHorrorChannelId,
        title: 'Retro Horror',
        version: 1,
      );

  @override
  Widget build(ChannelContext context) => const Center(
        child: Text(
          'Retro Horror · coming soon',
          textDirection: TextDirection.ltr,
        ),
      );
}
