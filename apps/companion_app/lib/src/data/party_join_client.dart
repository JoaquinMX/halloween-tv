/// Anonymous registration callable used before a companion manifest read.
library;

import 'dart:async';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:infra_firestore/infra_firestore.dart'
    show ManifestTransportException;

const String kJoinPartyCallable = 'joinParty';

/// Callable boundary kept separate from the read-only manifest invoker.
abstract interface class PartyJoinCallableInvoker {
  Future<Object?> call(String name, Map<String, Object?> payload);
}

/// Registers a phone identity and validates the server's scoped response.
final class PartyJoinClient {
  PartyJoinClient({
    required PartyJoinCallableInvoker invoker,
    this.timeout = const Duration(seconds: 10),
  }) : _invoker = invoker;

  final PartyJoinCallableInvoker _invoker;
  final Duration timeout;

  Future<void> register({
    required String partyId,
    required String deviceId,
    required String channelId,
    String? joinPin,
  }) async {
    final Map<String, Object?> payload = <String, Object?>{
      'partyId': partyId,
      'deviceId': deviceId,
      'channelId': channelId,
      if (joinPin != null) 'joinPin': joinPin,
    };
    try {
      final Object? raw = await _invoker
          .call(kJoinPartyCallable, payload)
          .timeout(timeout);
      if (raw is! Map ||
          raw['partyId'] != partyId ||
          raw['deviceId'] != deviceId ||
          raw['channelId'] != channelId ||
          raw['role'] != 'guest' ||
          raw['status'] != 'active' ||
          raw['created'] is! bool) {
        throw const FormatException(
          'joinParty response did not match the requested guest scope',
        );
      }
    } on TimeoutException catch (error) {
      throw ManifestTransportException('joinParty timed out', error);
    } on FirebaseFunctionsException catch (error) {
      throw ManifestTransportException('joinParty callable failed', error);
    }
  }
}

/// SDK-backed joinParty invoker, intentionally unable to make manifest calls.
final class CallablePartyJoinInvoker implements PartyJoinCallableInvoker {
  CallablePartyJoinInvoker({required FirebaseFunctions functions})
    : _functions = functions;
  final FirebaseFunctions _functions;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    if (name != kJoinPartyCallable) throw ArgumentError.value(name, 'name');
    return (await _functions
            .httpsCallable(kJoinPartyCallable)
            .call<Object?>(payload))
        .data;
  }
}
