/// Scoped host administration callables (seed catalog + previews).
///
/// Every operation revalidates the registered host role and party/channel
/// scope server-side (`assertRegisteredHostDevice`); guests get `FORBIDDEN`.
/// Payload/response shapes mirror `backend/functions/src/contracts.ts`.
///
/// Deletion granularity (pinned): `deleteHostVideo` deletes per selected
/// seed id — the seed entries and their associated preview + delivery
/// objects are removed, an affected current manifest whose jobId matches a
/// deleted seed is revoked, and accounting records (costLogs / usage ledger
/// rows) are never deleted. The list is reconciled only after authoritative
/// success; failures leave local state untouched so they stay retryable.
library;

import 'dart:async';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:infra_firestore/infra_firestore.dart'
    show ManifestTransportException;

const String kListHostVideos = 'listHostVideos';
const String kGenerateHostVideo = 'generateHostVideo';
const String kGetHostVideoPreview = 'getHostVideoPreview';
const String kDeleteHostVideo = 'deleteHostVideo';

/// Fixed generation presets supported by host administration.
///
/// Pinned to `backend/functions/src/config.ts` (`CHEAP_DEMO_PRESET` /
/// `CAMEO_DEMO_PRESET`). Generation presets keep producing 4 clips; the
/// preset value is never caller-tunable beyond this fixed set.
const String kCheapDemoPresetId = 'cheap_demo';
const String kCameoDemoPresetId = 'cameo_demo';

/// Callable boundary for host administration, separate from guest callables.
abstract interface class HostMediaCallableInvoker {
  Future<Object?> call(String name, Map<String, Object?> payload);
}

/// One server-backed seed catalog entry.
final class HostSeedVideo {
  const HostSeedVideo({
    required this.seedId,
    required this.partyId,
    required this.channelId,
    required this.status,
    required this.jobId,
    required this.createdAt,
    required this.expiresAt,
    required this.previewAvailable,
    required this.cameraIds,
  });

  final String seedId;
  final String partyId;
  final String channelId;

  /// Backend seed status: `queued`, `running`, `ready`, `failed`,
  /// `deleted` (expiry surfaces through the same status sync).
  final String status;
  final String jobId;
  final String createdAt;
  final String expiresAt;
  final bool previewAvailable;
  final List<String> cameraIds;

  @override
  bool operator ==(Object other) =>
      other is HostSeedVideo &&
      other.seedId == seedId &&
      other.partyId == partyId &&
      other.channelId == channelId &&
      other.status == status &&
      other.jobId == jobId &&
      other.previewAvailable == previewAvailable;

  @override
  int get hashCode =>
      Object.hash(seedId, partyId, channelId, status, jobId, previewAvailable);

  @override
  String toString() => 'HostSeedVideo($seedId status=$status)';
}

/// One signed preview clip reference (signed on demand, never persisted).
final class HostVideoPreviewClip {
  const HostVideoPreviewClip({
    required this.cameraId,
    required this.sha256,
    required this.url,
    required this.expiresAt,
  });

  final String cameraId;
  final String sha256;
  final Uri url;
  final String expiresAt;
}

/// Fresh scoped preview capability for one seed video.
final class HostVideoPreview {
  const HostVideoPreview({
    required this.seedId,
    required this.expiresAt,
    required this.clips,
  });

  final String seedId;
  final String expiresAt;
  final List<HostVideoPreviewClip> clips;
}

/// Scoped host media client: list / generate / preview / delete.
final class HostMediaClient {
  HostMediaClient({
    required HostMediaCallableInvoker invoker,
    this.timeout = const Duration(seconds: 15),
  }) : _invoker = invoker;

  final HostMediaCallableInvoker _invoker;
  final Duration timeout;

  Map<String, Object?> _scope(
    String partyId,
    String deviceId,
    String channelId,
  ) => <String, Object?>{
    'partyId': partyId,
    'deviceId': deviceId,
    'channelId': channelId,
  };

  Future<Object?> _call(String name, Map<String, Object?> payload) async {
    try {
      return await _invoker.call(name, payload).timeout(timeout);
    } on TimeoutException catch (error) {
      throw ManifestTransportException('$name timed out', error);
    }
  }

  /// Lists the server-backed seed catalog for the registered host scope.
  Future<List<HostSeedVideo>> listVideos({
    required String partyId,
    required String deviceId,
    required String channelId,
  }) async {
    final Object? raw;
    try {
      raw = await _call(kListHostVideos, _scope(partyId, deviceId, channelId));
    } on FirebaseFunctionsException catch (error) {
      throw ManifestTransportException('listHostVideos callable failed', error);
    }
    if (raw is! Map || raw['videos'] is! List) {
      throw const FormatException('Host video list response is malformed');
    }
    final List<HostSeedVideo> videos = <HostSeedVideo>[];
    for (final Object? entry in raw['videos'] as List) {
      videos.add(_parseSeed(entry, partyId: partyId, channelId: channelId));
    }
    return videos;
  }

  HostSeedVideo _parseSeed(
    Object? entry, {
    required String partyId,
    required String channelId,
  }) {
    if (entry is! Map) {
      throw const FormatException('Host seed entry is malformed');
    }
    String requiredString(String key) {
      final Object? value = entry[key];
      if (value is! String || value.isEmpty) {
        throw FormatException('Host seed entry field "$key" is malformed');
      }
      return value;
    }

    final String seedParty = requiredString('partyId');
    final String seedChannel = requiredString('channelId');
    if (seedParty != partyId || seedChannel != channelId) {
      throw const FormatException(
        'Host seed entry is outside the registered party and channel',
      );
    }
    final Object? cameras = entry['cameraIds'];
    if (entry['previewAvailable'] is! bool || cameras is! List) {
      throw const FormatException('Host seed entry fields are malformed');
    }
    return HostSeedVideo(
      seedId: requiredString('seedId'),
      partyId: seedParty,
      channelId: seedChannel,
      status: requiredString('status'),
      jobId: requiredString('jobId'),
      createdAt: requiredString('createdAt'),
      expiresAt: requiredString('expiresAt'),
      previewAvailable: entry['previewAvailable'] as bool,
      cameraIds: <String>[for (final Object? c in cameras) c.toString()],
    );
  }

  /// Enqueues fixed-preset generation for [seedId].
  ///
  /// [idempotencyKey] must be stable per seed id across retries so a retry
  /// reuses the queued job (`created: false`) instead of enqueueing another
  /// task. [presetId] defaults to the supported `cheap_demo` preset.
  Future<Map<String, Object?>> generateVideo({
    required String partyId,
    required String deviceId,
    required String channelId,
    required String seedId,
    required String idempotencyKey,
    String presetId = kCheapDemoPresetId,
    String? guestMediaId,
  }) async {
    if (presetId != kCheapDemoPresetId && presetId != kCameoDemoPresetId) {
      throw ArgumentError.value(
        presetId,
        'presetId',
        'Only the fixed generation presets are supported',
      );
    }
    final Object? raw;
    try {
      raw = await _call(kGenerateHostVideo, <String, Object?>{
        ..._scope(partyId, deviceId, channelId),
        'seedId': seedId,
        'idempotencyKey': idempotencyKey,
        'presetId': presetId,
        if (guestMediaId != null) 'guestMediaId': guestMediaId,
      });
    } on FirebaseFunctionsException catch (error) {
      throw ManifestTransportException(
        'generateHostVideo callable failed',
        error,
      );
    }
    if (raw is! Map ||
        raw['seedId'] != seedId ||
        raw['jobId'] is! String ||
        raw['state'] is! String ||
        raw['created'] is! bool) {
      throw const FormatException(
        'generateHostVideo response did not match the requested seed',
      );
    }
    return Map<String, Object?>.from(raw);
  }

  /// Obtains a fresh scoped preview capability for [seedId].
  ///
  /// Callers must request a new capability per view: signed URLs are
  /// short-lived and never persisted server-side.
  Future<HostVideoPreview> getPreview({
    required String partyId,
    required String deviceId,
    required String channelId,
    required String seedId,
  }) async {
    final Object? raw;
    try {
      raw = await _call(kGetHostVideoPreview, <String, Object?>{
        ..._scope(partyId, deviceId, channelId),
        'seedId': seedId,
      });
    } on FirebaseFunctionsException catch (error) {
      throw ManifestTransportException(
        'getHostVideoPreview callable failed',
        error,
      );
    }
    if (raw is! Map ||
        raw['seedId'] != seedId ||
        raw['expiresAt'] is! String ||
        raw['clips'] is! List) {
      throw const FormatException(
        'getHostVideoPreview response did not match the requested seed',
      );
    }
    final List<HostVideoPreviewClip> clips = <HostVideoPreviewClip>[];
    for (final Object? entry in raw['clips'] as List) {
      if (entry is! Map ||
          entry['cameraId'] is! String ||
          entry['sha256'] is! String ||
          entry['url'] is! String ||
          entry['expiresAt'] is! String) {
        throw const FormatException('Host preview clip is malformed');
      }
      final Uri? uri = Uri.tryParse(entry['url'] as String);
      if (uri == null ||
          uri.scheme != 'https' ||
          uri.host.isEmpty ||
          uri.userInfo.isNotEmpty) {
        throw const FormatException('Host preview URL is invalid');
      }
      clips.add(
        HostVideoPreviewClip(
          cameraId: entry['cameraId'] as String,
          sha256: entry['sha256'] as String,
          url: uri,
          expiresAt: entry['expiresAt'] as String,
        ),
      );
    }
    return HostVideoPreview(
      seedId: seedId,
      expiresAt: raw['expiresAt'] as String,
      clips: clips,
    );
  }

  /// Deletes the selected seed ids.
  ///
  /// Deletion is per selected seed id (see the library doc): preview +
  /// delivery objects for those seeds are removed, an affected current
  /// manifest is revoked, and accounting records are preserved. Only call
  /// after the caller reconciles on authoritative success.
  Future<Map<String, Object?>> deleteVideos({
    required String partyId,
    required String deviceId,
    required String channelId,
    required List<String> seedIds,
  }) async {
    final Object? raw;
    try {
      raw = await _call(kDeleteHostVideo, <String, Object?>{
        ..._scope(partyId, deviceId, channelId),
        'seedIds': seedIds,
      });
    } on FirebaseFunctionsException catch (error) {
      throw ManifestTransportException(
        'deleteHostVideo callable failed',
        error,
      );
    }
    if (raw is! Map ||
        raw['deletedSeedIds'] is! List ||
        raw['deletedObjects'] is! List ||
        raw['revokedManifest'] is! bool) {
      throw const FormatException('deleteHostVideo response is malformed');
    }
    return Map<String, Object?>.from(raw);
  }
}

/// SDK-backed host media invoker, scoped to the four host callables.
final class CallableHostMediaInvoker implements HostMediaCallableInvoker {
  CallableHostMediaInvoker({required FirebaseFunctions functions})
    : _functions = functions;
  final FirebaseFunctions _functions;

  static const Set<String> _allowed = <String>{
    kListHostVideos,
    kGenerateHostVideo,
    kGetHostVideoPreview,
    kDeleteHostVideo,
  };

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    if (!_allowed.contains(name)) throw ArgumentError.value(name, 'name');
    return (await _functions.httpsCallable(name).call<Object?>(payload)).data;
  }
}
