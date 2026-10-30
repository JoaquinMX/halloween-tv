/// Cancellable polling transport for the current manifest callable.
library;

import 'dart:async';

import 'package:cloud_functions/cloud_functions.dart';

import 'package:infra_firestore/src/firebase_manifest_source.dart';
import 'package:infra_firestore/src/firebase_tv_identity.dart';

/// Injectable callable boundary for tests and Functions emulator wiring.
abstract interface class FirebaseManifestCallableInvoker {
  /// Calls [name] with a party/device/channel scoped [payload].
  Future<Object?> call(String name, Map<String, Object?> payload);
}

final class _SdkManifestCallableInvoker
    implements FirebaseManifestCallableInvoker {
  _SdkManifestCallableInvoker(this._functions);

  final FirebaseFunctions _functions;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    final HttpsCallableResult<Object?> result = await _functions
        .httpsCallable(name)
        .call<Object?>(payload);
    return result.data;
  }
}

/// Reads `getCurrentManifest` and presents its documents to
/// [FirebaseManifestSource]'s existing `watchDocumentData` seam.
///
/// The SDK is resolved only after a listener subscribes. Polls continue until
/// the listener cancels; consecutive failures use capped retries and then
/// surface as [ManifestTransportException], allowing the source to make a
/// bounded resubscription of the callable stream.
final class FirebaseCallableManifestTransport {
  /// Creates a transport for a provisioned TV [identity].
  FirebaseCallableManifestTransport({
    required FirebaseTvIdentity identity,
    FirebaseFunctions? functions,
    FirebaseManifestCallableInvoker? callableInvoker,
    this.pollInterval = const Duration(seconds: 5),
    this.maxConsecutiveFailures = 3,
    this.initialRetryDelay = const Duration(milliseconds: 250),
    this.maxRetryDelay = const Duration(seconds: 2),
  }) : _identity = identity,
       _functions = functions,
       _callableInvoker = callableInvoker {
    if (functions != null && callableInvoker != null) {
      throw ArgumentError(
        'provide either functions or callableInvoker, not both',
      );
    }
    if (pollInterval.isNegative || pollInterval == Duration.zero) {
      throw ArgumentError.value(pollInterval, 'pollInterval');
    }
    if (maxConsecutiveFailures < 0) {
      throw ArgumentError.value(
        maxConsecutiveFailures,
        'maxConsecutiveFailures',
      );
    }
    if (initialRetryDelay.isNegative || maxRetryDelay < initialRetryDelay) {
      throw ArgumentError('retry delays must be non-negative and capped');
    }
  }

  final FirebaseTvIdentity _identity;
  final FirebaseFunctions? _functions;
  final FirebaseManifestCallableInvoker? _callableInvoker;

  /// Delay between successful current-manifest observations.
  final Duration pollInterval;

  /// Maximum number of retries after a consecutive callable failure.
  final int maxConsecutiveFailures;

  /// Delay before the first retry.
  final Duration initialRetryDelay;

  /// Maximum retry delay, regardless of the failure count.
  final Duration maxRetryDelay;

  /// Returns document data for the requested
  /// `parties/{partyId}/manifests/current_{channelId}` path.
  ///
  /// Pass this method as `FirebaseManifestSource(watchDocumentData: ...)` to
  /// retain the source's normal Firestore mapper and request/document scope
  /// checks.
  Stream<Map<String, Object?>?> watchDocumentData(String documentPath) {
    final String channelId = _channelFromPath(documentPath);
    late final StreamController<Map<String, Object?>?> controller;
    var cancelled = false;
    Timer? timer;
    var failures = 0;

    Future<void> poll() async {
      if (cancelled) return;
      try {
        final FirebaseManifestCallableInvoker invoker =
            _callableInvoker ??
            _SdkManifestCallableInvoker(
              _functions ?? FirebaseFunctions.instance,
            );
        final Object? raw = await invoker.call(
          'getCurrentManifest',
          _identity.callablePayload(channelId: channelId),
        );
        if (cancelled) return;
        if (raw is! Map) {
          throw const FormatException(
            'getCurrentManifest response must be an object',
          );
        }
        final Map<String, Object?> document = <String, Object?>{};
        for (final MapEntry<Object?, Object?> entry in raw.entries) {
          if (entry.key is! String) {
            throw const FormatException(
              'getCurrentManifest response keys must be strings',
            );
          }
          document[entry.key! as String] = entry.value;
        }
        failures = 0;
        controller.add(document);
        timer = Timer(pollInterval, () => unawaited(poll()));
      } on Object catch (error, stackTrace) {
        if (cancelled) return;
        if (failures >= maxConsecutiveFailures) {
          controller.addError(
            ManifestTransportException(
              'getCurrentManifest callable failed',
              error,
            ),
            stackTrace,
          );
          await controller.close();
          return;
        }
        failures++;
        timer = Timer(_retryDelay(failures), () => unawaited(poll()));
      }
    }

    controller = StreamController<Map<String, Object?>?>(
      onListen: () => unawaited(poll()),
      onCancel: () {
        cancelled = true;
        timer?.cancel();
      },
    );
    return controller.stream;
  }

  Duration _retryDelay(int failure) {
    var milliseconds = initialRetryDelay.inMilliseconds;
    for (
      var index = 1;
      index < failure && milliseconds < maxRetryDelay.inMilliseconds;
      index++
    ) {
      milliseconds = (milliseconds * 2).clamp(0, maxRetryDelay.inMilliseconds);
    }
    return Duration(
      milliseconds: milliseconds.clamp(0, maxRetryDelay.inMilliseconds),
    );
  }

  String _channelFromPath(String path) {
    final String prefix = 'parties/${_identity.partyId}/manifests/current_';
    if (!path.startsWith(prefix)) {
      throw ArgumentError.value(path, 'documentPath', 'is outside TV scope');
    }
    final String channelId = path.substring(prefix.length);
    if (channelId.isEmpty || channelId.contains('/')) {
      throw ArgumentError.value(path, 'documentPath', 'is not a manifest path');
    }
    return channelId;
  }
}
