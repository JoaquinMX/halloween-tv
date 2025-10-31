library channel_api;

import 'package:flutter/widgets.dart';

import 'package:core_cache/core_cache.dart';
import 'package:core_effects/core_effects.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';

export 'package:core_cache/core_cache.dart' show CachePort, ClipRef, FileRef, MediaFetchPort;
export 'package:core_effects/core_effects.dart' show EffectsEngine, EffectsPreset;
export 'package:core_foundation/core_foundation.dart' show AppSettings, SettingsPort;
export 'package:core_playlist/core_playlist.dart';

/// Descriptor for a channel plugin.
class ChannelDescriptor {
  const ChannelDescriptor(this.id, this.name, this.version);

  final String id;
  final String name;
  final String version;
}

/// Context provided to channel plugins at runtime.
class ChannelContext {
  const ChannelContext({
    required this.playlistPort,
    required this.mediaFetchPort,
    required this.cachePort,
    required this.effectsEngine,
    required this.settingsPort,
    required this.partyId,
  });

  final PlaylistPort playlistPort;
  final MediaFetchPort mediaFetchPort;
  final CachePort cachePort;
  final EffectsEngine effectsEngine;
  final SettingsPort settingsPort;
  final String partyId;
}

/// Base interface implemented by channel plugins.
abstract class ChannelPlugin {
  ChannelDescriptor get descriptor;
  Widget buildEntry(ChannelContext context);
}
