/// Test fakes and fixtures for Halloween TV contracts.
library;

import 'package:channel_api/channel_api.dart';
import 'package:core_cache/core_cache.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter/widgets.dart';

/// Controllable clock for tests.
final class FakeClock implements Clock {
  /// Current fake time.
  DateTime current;

  FakeClock([DateTime? initial])
    : current = initial ?? DateTime.utc(2026, 10, 31, 20);

  @override
  DateTime now() => current;

  /// Advances the clock by [by].
  void advance(Duration by) {
    current = current.add(by);
  }

  /// Jumps the clock to [instant].
  void setTo(DateTime instant) {
    current = instant;
  }
}

/// In-memory [CacheStore] for tests.
///
/// Stores committed entries keyed by clip id; [findVerified] returns the
/// entry only when its sha256 matches the requested clip's sha256, so a
/// stale/corrupt entry surfaces as a cache miss exactly like a real store.
final class FakeCacheStore implements CacheStore {
  final Map<String, CachedMedia> _entries = <String, CachedMedia>{};

  @override
  Future<CachedMedia?> findVerified(ClipDescriptor clip) async =>
      switch (_entries[clip.id]) {
        CachedMedia entry when entry.sha256 == clip.sha256 => entry,
        _ => null,
      };

  @override
  Future<CachedMedia> commit(DownloadedMedia media) async {
    final entry = CachedMedia(
      clipId: media.clipId,
      localRef: 'mem://${media.clipId}',
      sha256: media.sha256,
    );
    _entries[media.clipId] = entry;
    return entry;
  }

  @override
  Future<int> deleteExpired() async {
    final count = _entries.length;
    _entries.clear();
    return count;
  }

  /// Inserts/replaces an entry without going through [commit], simulating a
  /// pre-existing or corrupted cache. Returns the stored entry.
  CachedMedia seed(CachedMedia entry) {
    _entries[entry.clipId] = entry;
    return entry;
  }

  /// Number of stored entries (test inspection only).
  int get size => _entries.length;

  /// Stored entry for [clipId], if any (test inspection only).
  CachedMedia? entryFor(String clipId) => _entries[clipId];
}

/// No-op playback handle recording prepare/activate calls in order.
final class FakePlaybackHandle implements PlaybackHandle {
  /// Whether [prepare] was called.
  bool prepared = false;

  /// Whether [activate] was called.
  bool activated = false;

  /// Call log in invocation order (`prepare`, `activate`).
  final List<String> events = <String>[];

  @override
  Future<void> prepare() async {
    prepared = true;
    events.add('prepare');
  }

  @override
  Future<void> activate() async {
    activated = true;
    events.add('activate');
  }
}

/// Minimal test channel plugin.
final class FakeChannelPlugin implements ChannelPlugin {
  @override
  final ChannelDescriptor descriptor;

  /// Widget to return from [build].
  final Widget widget;

  FakeChannelPlugin(this.descriptor, [this.widget = const SizedBox.shrink()]);

  @override
  Widget build(ChannelContext context) => widget;
}

String _sha(String seed) {
  // Deterministic 64-hex-char pseudo digest (test-only, not cryptographic).
  final units = seed.codeUnits;
  final buf = StringBuffer();
  var h = 0x811c9dc5;
  while (buf.length < 64) {
    for (final u in units) {
      h = ((h ^ u) * 16777619) & 0xffffffff;
      buf.write(h.toRadixString(16).padLeft(8, '0'));
      if (buf.length >= 64) {
        break;
      }
    }
  }
  return buf.toString().substring(0, 64);
}

/// Returns a valid 4-clip CCTV manifest fixture.
///
/// TEST-ONLY: digests here are deterministic fabricated placeholders, not
/// real asset hashes. Production boot must NOT use this — it loads the
/// bundled `assets/fixture_manifest.json` (emitted from real asset bytes)
/// via `rootBundle` + `parseManifest` instead.
PlaybackManifest manifestFixture({
  String partyId = 'party-1',
  String channelId = 'cctv',
  int version = 1,
  OverlaySettings overlay = const OverlaySettings(),
  DateTime? publishedAt,
}) {
  return PlaybackManifest(
    partyId: partyId,
    channelId: channelId,
    version: version,
    publishedAt: publishedAt ?? DateTime.utc(2026, 10, 31, 20),
    overlay: overlay,
    clips: <ClipDescriptor>[
      for (var i = 1; i <= 4; i++)
        ClipDescriptor(
          id: 'clip-0$i',
          cameraId: 'CAM-0$i',
          storageObjectId: 'obj-0$i',
          sha256: _sha('clip-0$i'),
          sizeBytes: 1024 * i,
          duration: const Duration(seconds: 10),
          mimeType: 'video/mp4',
        ),
    ],
  );
}
