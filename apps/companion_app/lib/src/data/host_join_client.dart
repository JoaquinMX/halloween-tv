/// Host invite redemption callable used before host administration.
library;

import 'dart:async';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:infra_firestore/infra_firestore.dart'
    show ManifestTransportException;

const String kJoinHostCallable = 'joinHost';

/// Callable boundary kept separate from the guest `joinParty` boundary.
///
/// Guest entry must never register a host payload through `joinParty`, and
/// host entry must never redeem through it either: the two routes use
/// disjoint callables, disjoint device identities, and server-assigned
/// roles (see `backend/functions/src/host_join.ts`).
abstract interface class HostJoinCallableInvoker {
  Future<Object?> call(String name, Map<String, Object?> payload);
}

/// Redeems a host invite and validates the server's scoped host response.
final class HostJoinClient {
  HostJoinClient({
    required HostJoinCallableInvoker invoker,
    this.timeout = const Duration(seconds: 10),
  }) : _invoker = invoker;

  final HostJoinCallableInvoker _invoker;
  final Duration timeout;

  Future<void> redeem({
    required String partyId,
    required String deviceId,
    required String channelId,
    required String inviteToken,
  }) async {
    final Map<String, Object?> payload = <String, Object?>{
      'partyId': partyId,
      'deviceId': deviceId,
      'channelId': channelId,
      'inviteToken': inviteToken,
    };
    try {
      final Object? raw = await _invoker
          .call(kJoinHostCallable, payload)
          .timeout(timeout);
      if (raw is! Map ||
          raw['partyId'] != partyId ||
          raw['deviceId'] != deviceId ||
          raw['channelId'] != channelId ||
          raw['role'] != 'host' ||
          raw['status'] != 'active' ||
          raw['created'] is! bool) {
        throw const FormatException(
          'joinHost response did not match the requested host scope',
        );
      }
    } on TimeoutException catch (error) {
      throw ManifestTransportException('joinHost timed out', error);
    } on FirebaseFunctionsException catch (error) {
      throw ManifestTransportException('joinHost callable failed', error);
    }
  }
}

/// SDK-backed joinHost invoker, intentionally unable to make other calls.
final class CallableHostJoinInvoker implements HostJoinCallableInvoker {
  CallableHostJoinInvoker({required FirebaseFunctions functions})
    : _functions = functions;
  final FirebaseFunctions _functions;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    if (name != kJoinHostCallable) throw ArgumentError.value(name, 'name');
    return (await _functions
            .httpsCallable(kJoinHostCallable)
            .call<Object?>(payload))
        .data;
  }
}
