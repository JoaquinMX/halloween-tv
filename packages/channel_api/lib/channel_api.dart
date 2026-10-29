/// Channel plugin contract (Technical Design v1.0, section 7).
library;

import 'package:core_foundation/core_foundation.dart';
import 'package:flutter/widgets.dart';

export 'package:core_foundation/core_foundation.dart' show PartyId;

/// Opaque playback control surface handed to channels.
///
/// Kept `dynamic`-free: channels only see [prepare]/[activate]; the kernel
/// owns the concrete player behind it.
abstract class PlaybackHandle {
  /// Prepare playback resources without showing anything yet.
  Future<void> prepare();

  /// Activate playback (become visible / audible).
  Future<void> activate();
}

/// Capability flags advertised by a channel.
final class ChannelCapability {
  /// Can play video clips.
  final bool videoPlayback;

  /// Supports visual effects overlays.
  final bool effects;

  /// Supports timed/scheduled events.
  final bool timedEvents;

  /// Supports guest-supplied media.
  final bool guestMedia;

  const ChannelCapability({
    this.videoPlayback = false,
    this.effects = false,
    this.timedEvents = false,
    this.guestMedia = false,
  });

  Map<String, Object?> toJson() => <String, Object?>{
        'videoPlayback': videoPlayback,
        'effects': effects,
        'timedEvents': timedEvents,
        'guestMedia': guestMedia,
      };

  factory ChannelCapability.fromJson(Map<String, Object?> json) =>
      ChannelCapability(
        videoPlayback: json['videoPlayback'] == true,
        effects: json['effects'] == true,
        timedEvents: json['timedEvents'] == true,
        guestMedia: json['guestMedia'] == true,
      );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is ChannelCapability &&
          other.videoPlayback == videoPlayback &&
          other.effects == effects &&
          other.timedEvents == timedEvents &&
          other.guestMedia == guestMedia);

  @override
  int get hashCode =>
      Object.hash(videoPlayback, effects, timedEvents, guestMedia);

  @override
  String toString() => 'ChannelCapability(video: $videoPlayback, '
      'effects: $effects, timed: $timedEvents, guest: $guestMedia)';
}

/// Static metadata describing a channel plugin.
final class ChannelDescriptor {
  /// Unique channel id (e.g. `cctv`); must be non-empty.
  final String id;

  /// Human-readable title; must be non-empty.
  final String title;

  /// Descriptor version, must be > 0.
  final int version;

  /// Advertised capabilities.
  final ChannelCapability capabilities;

  const ChannelDescriptor({
    required this.id,
    required this.title,
    required this.version,
    this.capabilities = const ChannelCapability(),
  })  : assert(id != '', 'ChannelDescriptor.id must be non-empty'),
        assert(title != '', 'ChannelDescriptor.title must be non-empty'),
        assert(version > 0, 'ChannelDescriptor.version must be > 0');

  Map<String, Object?> toJson() => <String, Object?>{
        'id': id,
        'title': title,
        'version': version,
        'capabilities': capabilities.toJson(),
      };

  /// Decodes a descriptor, throwing [FormatException] on bad shape.
  factory ChannelDescriptor.fromJson(Map<String, Object?> json) {
    final id = json['id'];
    final title = json['title'];
    final version = json['version'];
    if (id is! String || title is! String || version is! num) {
      throw const FormatException(
          'descriptor requires string id/title and numeric version');
    }
    final rawCapabilities = json['capabilities'];
    if (rawCapabilities != null && rawCapabilities is! Map) {
      throw const FormatException('capabilities must be a JSON object');
    }
    return ChannelDescriptor(
      id: id,
      title: title,
      version: version.toInt(),
      capabilities: rawCapabilities == null
          ? const ChannelCapability()
          : ChannelCapability.fromJson(
              Map<String, Object?>.from(
                  rawCapabilities as Map<Object?, Object?>),
            ),
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is ChannelDescriptor &&
          other.id == id &&
          other.title == title &&
          other.version == version &&
          other.capabilities == capabilities);

  @override
  int get hashCode => Object.hash(id, title, version, capabilities);

  @override
  String toString() => 'ChannelDescriptor($id, v$version)';
}

/// Typed wrapper around raw channel settings.
final class ChannelSettings {
  /// Raw settings values (read-only view).
  final Map<String, Object?> values;

  const ChannelSettings([Map<String, Object?>? values])
      : values = values ?? const <String, Object?>{};

  /// Reads key [key] or returns [fallback] when absent or of another type.
  T get<T>(String key, T fallback) {
    final v = values[key];
    if (v is T) {
      return v;
    }
    return fallback;
  }

  /// True when no settings are present.
  bool get isEmpty => values.isEmpty;

  Map<String, Object?> toJson() => Map<String, Object?>.of(values);

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) {
      return true;
    }
    if (other is! ChannelSettings || other.values.length != values.length) {
      return false;
    }
    for (final entry in values.entries) {
      if (!other.values.containsKey(entry.key) ||
          other.values[entry.key] != entry.value) {
        return false;
      }
    }
    return true;
  }

  @override
  int get hashCode => Object.hashAllUnordered(
      values.entries.map((e) => Object.hash(e.key, e.value)));

  @override
  String toString() => 'ChannelSettings($values)';
}

/// Context handed to [ChannelPlugin.build].
final class ChannelContext {
  /// Party this channel instance belongs to.
  final PartyId partyId;

  /// Opaque playback handle owned by the kernel.
  final PlaybackHandle playbackHandle;

  /// Per-channel settings.
  final ChannelSettings settings;

  const ChannelContext({
    required this.partyId,
    required this.playbackHandle,
    this.settings = const ChannelSettings(),
  });
}

/// Channel plugin contract: descriptor + widget builder.
abstract class ChannelPlugin {
  /// Static metadata for this channel.
  ChannelDescriptor get descriptor;

  /// Builds the channel UI for [context].
  Widget build(ChannelContext context);
}
