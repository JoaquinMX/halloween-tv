import 'dart:async';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:retry/retry.dart';

import 'package:core_cache/core_cache.dart';
import 'package:core_foundation/core_foundation.dart';

/// Adapter that fetches signed URLs and persists them via the cache port.
class SignedUrlFetcher implements MediaFetchPort {
  SignedUrlFetcher({
    required CachePort cachePort,
    http.Client? client,
    Duration timeout = CoreConstants.defaultHttpTimeout,
    RetryOptions? retryOptions,
  })  : _cachePort = cachePort,
        _client = client ?? http.Client(),
        _timeout = timeout,
        _retry = retryOptions ?? RetryOptions(maxAttempts: 4, delayFactor: const Duration(milliseconds: 500));

  final CachePort _cachePort;
  final http.Client _client;
  final Duration _timeout;
  final RetryOptions _retry;

  @override
  Future<bool> exists(String localKey, {String? checksum}) async {
    final FileRef? cached = await _cachePort.get(localKey);
    if (cached == null) {
      return false;
    }
    if (checksum == null) {
      return true;
    }
    return cached.checksum == checksum;
  }

  @override
  Future<FileRef> prefetch(ClipRef ref, {required String checksum}) async {
    return _retry.retry<FileRef>(
      () async {
        final http.Request request = http.Request('GET', Uri.parse(ref.signedUrl));
        final http.StreamedResponse response = await _client.send(request).timeout(_timeout);
        if (response.statusCode != HttpStatus.ok) {
          throw NetworkFailure('Failed to fetch media (${response.statusCode}).');
        }
        final int? contentLength = response.contentLength;
        if (contentLength != null && contentLength > ref.sizeBytes) {
          throw NetworkFailure('Fetched size exceeds declared clip size.');
        }
        return _cachePort.put(ref.localKey, response.stream, checksum: checksum);
      },
      retryIf: (Object error) => error is IOException || error is TimeoutException || error is NetworkFailure,
    );
  }
}
