/// HTTPS media downloader with partial-file cleanup and content verification.
library;

import 'dart:async';
import 'dart:io';

import 'package:core_cache/core_cache.dart';
import 'package:core_playlist/core_playlist.dart';

/// Refreshes one expired signed URL for the same manifest clip.
typedef ExpiredUrlRefresher =
    Future<Uri> Function(ClipDescriptor clip, Uri expiredUrl);

/// Downloads HTTPS clips through a temporary `.part` file, then checks the
/// exact byte count and SHA-256 before returning bytes to the cache pipeline.
///
/// [CacheStore] owns durable atomic commit. [downloadAndCommit] is a helper
/// that performs that same commit directly for callers outside
/// `PreparePlayback`. The concurrency cap is fixed at two downloads.
final class HttpsMediaDownloader implements MediaDownloader {
  HttpsMediaDownloader({
    this.tempDirectory,
    this.expiredUrlRefresher,
    HttpClient? httpClient,
  }) : _providedHttpClient = httpClient;

  static const int maxConcurrentDownloads = 2;

  /// Optional parent for isolated per-download staging directories.
  final Directory? tempDirectory;

  /// Optional callback to obtain a new URL after an expired URL response.
  final ExpiredUrlRefresher? expiredUrlRefresher;

  final HttpClient? _providedHttpClient;
  final _DownloadSemaphore _slots = _DownloadSemaphore(maxConcurrentDownloads);

  @override
  Future<DownloadedMedia> downloadAndVerify(ClipDescriptor clip, Uri source) =>
      _slots.withPermit(() => _download(clip, source));

  /// Downloads, verifies, and atomically commits through [cacheStore].
  Future<CachedMedia> downloadAndCommit({
    required ClipDescriptor clip,
    required Uri source,
    required CacheStore cacheStore,
  }) async {
    final DownloadedMedia media = await downloadAndVerify(clip, source);
    return cacheStore.commit(media);
  }

  Future<DownloadedMedia> _download(
    ClipDescriptor clip,
    Uri initialSource,
  ) async {
    _validateSource(initialSource);
    final Directory parent = tempDirectory ?? Directory.systemTemp;
    final Directory staging = await parent.createTemp('halloween-media-');
    final File partial = File(
      '${staging.path}${Platform.pathSeparator}${_safeFileStem(clip.id)}.part',
    );
    final HttpClient client = _providedHttpClient ?? HttpClient();
    client.connectionTimeout = const Duration(seconds: 30);
    var shouldCloseClient = _providedHttpClient == null;
    Uri source = initialSource;
    try {
      for (var attempt = 0; attempt < 2; attempt++) {
        _validateSource(source);
        final HttpClientRequest request = await client.getUrl(source);
        request.headers.set(HttpHeaders.acceptHeader, clip.mimeType);
        final HttpClientResponse response = await request.close();
        if (_isExpiredStatus(response.statusCode)) {
          await response.drain<void>();
          final ExpiredUrlRefresher? refresh = expiredUrlRefresher;
          if (attempt == 0 && refresh != null) {
            source = await refresh(clip, source);
            continue;
          }
          throw HttpException(
            'signed media URL expired or was rejected '
            '(HTTP ${response.statusCode})',
            uri: source,
          );
        }
        if (response.statusCode != HttpStatus.ok) {
          await response.drain<void>();
          throw HttpException(
            'media download failed with HTTP ${response.statusCode}',
            uri: source,
          );
        }

        var byteCount = 0;
        final List<int> bytes = <int>[];
        final IOSink sink = partial.openWrite();
        try {
          await for (final List<int> chunk in response) {
            byteCount += chunk.length;
            if (byteCount > clip.sizeBytes) {
              throw const FormatException('download exceeded declared size');
            }
            bytes.addAll(chunk);
            sink.add(chunk);
          }
          await sink.flush();
        } finally {
          await sink.close();
        }
        if (byteCount != clip.sizeBytes) {
          throw FormatException(
            'download byte count $byteCount did not match '
            'declared ${clip.sizeBytes}',
          );
        }
        final List<int> persisted = await partial.readAsBytes();
        if (persisted.length != clip.sizeBytes ||
            sha256Hex(persisted).toLowerCase() != clip.sha256.toLowerCase()) {
          throw const FormatException('download SHA-256 verification failed');
        }
        return DownloadedMedia.fromBytes(clipId: clip.id, bytes: persisted);
      }
      throw StateError('URL refresh loop exhausted');
    } finally {
      if (shouldCloseClient) {
        client.close(force: true);
        shouldCloseClient = false;
      }
      if (await staging.exists()) {
        await staging.delete(recursive: true);
      }
    }
  }

  static bool _isExpiredStatus(int statusCode) =>
      statusCode == HttpStatus.unauthorized ||
      statusCode == HttpStatus.forbidden ||
      statusCode == HttpStatus.gone;

  static void _validateSource(Uri source) {
    if (source.scheme != 'https' ||
        source.host.isEmpty ||
        source.userInfo.isNotEmpty) {
      throw ArgumentError.value(
        source,
        'source',
        'signed media source must be an HTTPS URI without user info',
      );
    }
  }

  static String _safeFileStem(String value) =>
      value.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');
}

final class _DownloadSemaphore {
  _DownloadSemaphore(this.limit);

  final int limit;
  final List<Completer<void>> _waiters = <Completer<void>>[];
  int _active = 0;

  Future<T> withPermit<T>(Future<T> Function() action) async {
    if (_active >= limit) {
      final Completer<void> waiter = Completer<void>();
      _waiters.add(waiter);
      await waiter.future;
    } else {
      _active++;
    }
    try {
      return await action();
    } finally {
      if (_waiters.isEmpty) {
        _active--;
      } else {
        _waiters.removeAt(0).complete();
      }
    }
  }
}
