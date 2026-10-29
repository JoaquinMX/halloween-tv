/// Channel registry for the app kernel (Technical Design v1.0, section 7).
library;

import 'package:channel_api/channel_api.dart';

export 'package:channel_api/channel_api.dart';

/// Registry of channel plugins keyed by descriptor id.
///
/// Registering two plugins with the same id throws [StateError]; the first
/// registration is kept intact.
final class ChannelRegistry {
  final Map<String, ChannelPlugin> _plugins = <String, ChannelPlugin>{};

  /// Registers [plugin]; throws [StateError] on duplicate id and
  /// [ArgumentError] when the descriptor id is blank.
  void register(ChannelPlugin plugin) {
    final id = plugin.descriptor.id;
    if (id.trim().isEmpty) {
      throw ArgumentError.value(
        id,
        'plugin.descriptor.id',
        'channel id must be non-empty',
      );
    }
    if (_plugins.containsKey(id)) {
      throw StateError('Channel already registered: $id');
    }
    _plugins[id] = plugin;
  }

  /// Resolves the plugin for [id], or null when unknown.
  ChannelPlugin? resolve(String id) => _plugins[id];

  /// True when a plugin is registered for [id].
  bool contains(String id) => _plugins.containsKey(id);

  /// Number of registered channels.
  int get length => _plugins.length;

  /// All registered ids in registration order.
  List<String> get allIds => List<String>.unmodifiable(_plugins.keys);
}

/// Returns descriptors for every registered channel, sorted by id.
List<ChannelDescriptor> buildChannelList(ChannelRegistry registry) {
  final descriptors = registry.allIds
      .map((id) => registry.resolve(id)!.descriptor)
      .toList(growable: false);
  descriptors.sort((a, b) => a.id.compareTo(b.id));
  return List<ChannelDescriptor>.unmodifiable(descriptors);
}
