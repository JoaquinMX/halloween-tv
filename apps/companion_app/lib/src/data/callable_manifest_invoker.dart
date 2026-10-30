/// Thin callable invoker restricted to the read-only `getCurrentManifest`.
///
/// Only `getCurrentManifest` may be invoked, and only with exactly
/// `{partyId, deviceId, channelId}`. Every call is bounded by [timeout]
/// (~10s). Transport and Functions errors are wrapped in
/// [ManifestTransportException] with their original cause preserved so
/// [ManifestFailure.classify] can sanitize them; nothing here interprets
/// payloads beyond the exact-key envelope check.
library;

import 'dart:async';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:infra_firestore/infra_firestore.dart'
    show FirebaseManifestCallableInvoker, ManifestTransportException;

/// Exact callable name. No other callable is reachable through this type.
const String kGetCurrentManifestCallable = 'getCurrentManifest';

/// Exact payload keys. No `getDeliveryUrls`, `acknowledgeDelivery`, or
/// `requestGeneration` fields may pass through this invoker.
const Set<String> kManifestPayloadKeys = <String>{
  'partyId',
  'deviceId',
  'channelId',
};

/// SDK-backed invoker for the read-only manifest callable.
final class CallableManifestInvoker implements FirebaseManifestCallableInvoker {
  CallableManifestInvoker({
    required FirebaseFunctions functions,
    this.timeout = const Duration(seconds: 10),
  }) : _functions = functions,
       _handler = null;

  /// Test seam: [handler] substitutes ONLY the external SDK call boundary.
  CallableManifestInvoker.forTest({
    required Future<Object?> Function(String name, Map<String, Object?> payload)
    handler,
    this.timeout = const Duration(seconds: 10),
  }) : _functions = null,
       _handler = handler;

  final FirebaseFunctions? _functions;
  final Future<Object?> Function(String name, Map<String, Object?> payload)?
  _handler;
  final Duration timeout;

  /// Invokes `getCurrentManifest` with exactly the party/device/channel
  /// scope and returns the raw document map.
  Future<Map<String, Object?>> getCurrentManifest({
    required String partyId,
    required String deviceId,
    required String channelId,
  }) async {
    final Object? raw = await call(
      kGetCurrentManifestCallable,
      <String, Object?>{
        'partyId': partyId,
        'deviceId': deviceId,
        'channelId': channelId,
      },
    );
    if (raw is! Map) {
      throw const ManifestTransportException(
        'getCurrentManifest response must be an object',
        FormatException('getCurrentManifest response must be an object'),
      );
    }
    final Map<String, Object?> document = <String, Object?>{};
    for (final MapEntry<Object?, Object?> entry in raw.entries) {
      if (entry.key is! String) {
        throw const ManifestTransportException(
          'getCurrentManifest response keys must be strings',
          FormatException('response keys must be strings'),
        );
      }
      document[entry.key! as String] = entry.value;
    }
    return document;
  }

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    if (name != kGetCurrentManifestCallable) {
      throw ArgumentError.value(
        name,
        'name',
        'only $kGetCurrentManifestCallable may be invoked',
      );
    }
    if (payload.keys.length != kManifestPayloadKeys.length ||
        !kManifestPayloadKeys.containsAll(payload.keys)) {
      throw ArgumentError.value(
        payload.keys.toList(growable: false),
        'payload',
        'must be exactly $kManifestPayloadKeys',
      );
    }
    try {
      final Object? data;
      final Future<Object?> Function(String, Map<String, Object?>) handler =
          _handler ?? _sdkCall;
      data = await handler(name, payload).timeout(timeout);
      return data;
    } on TimeoutException catch (error) {
      throw ManifestTransportException('getCurrentManifest timed out', error);
    } on FirebaseFunctionsException catch (error) {
      throw ManifestTransportException(
        'getCurrentManifest callable failed',
        error,
      );
    }
  }

  Future<Object?> _sdkCall(String name, Map<String, Object?> payload) async {
    final HttpsCallableResult<Object?> result = await _functions!
        .httpsCallable(name)
        .call<Object?>(payload);
    return result.data;
  }
}
