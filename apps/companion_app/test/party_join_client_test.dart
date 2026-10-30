import 'dart:async';

import 'package:companion_app/src/data/party_join_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_firestore/infra_firestore.dart'
    show ManifestTransportException;

final class FakeJoinInvoker implements PartyJoinCallableInvoker {
  FakeJoinInvoker(this.result);
  Object? result;
  String? name;
  Map<String, Object?>? payload;
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    this.name = name;
    this.payload = Map<String, Object?>.of(payload);
    return result;
  }
}

void main() {
  test('calls joinParty with the exact scoped identity and PIN', () async {
    final FakeJoinInvoker invoker = FakeJoinInvoker(<String, Object?>{
      'partyId': 'party-1',
      'deviceId': 'p-0123456789abcdef0123456789abcdef',
      'channelId': 'cctv',
      'role': 'guest',
      'status': 'active',
      'created': true,
    });
    await PartyJoinClient(invoker: invoker).register(
      partyId: 'party-1',
      deviceId: 'p-0123456789abcdef0123456789abcdef',
      channelId: 'cctv',
      joinPin: '004201',
    );
    expect(invoker.name, 'joinParty');
    expect(invoker.payload, <String, Object?>{
      'partyId': 'party-1',
      'deviceId': 'p-0123456789abcdef0123456789abcdef',
      'channelId': 'cctv',
      'joinPin': '004201',
    });
  });

  test('rejects mismatched and malformed responses', () async {
    final FakeJoinInvoker invoker = FakeJoinInvoker(<String, Object?>{
      'partyId': 'other',
      'deviceId': 'p-0123456789abcdef0123456789abcdef',
      'channelId': 'cctv',
      'role': 'guest',
      'status': 'active',
      'created': true,
    });
    await expectLater(
      PartyJoinClient(invoker: invoker).register(
        partyId: 'party-1',
        deviceId: 'p-0123456789abcdef0123456789abcdef',
        channelId: 'cctv',
      ),
      throwsFormatException,
    );
  });

  test('bounds a callable that never completes', () async {
    // Use a real pending boundary through a local implementation.
    final PartyJoinClient client = PartyJoinClient(
      invoker: _PendingInvoker(),
      timeout: const Duration(milliseconds: 5),
    );
    await expectLater(
      client.register(
        partyId: 'party-1',
        deviceId: 'p-0123456789abcdef0123456789abcdef',
        channelId: 'cctv',
      ),
      throwsA(isA<ManifestTransportException>()),
    );
  });
}

final class _PendingInvoker implements PartyJoinCallableInvoker {
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) =>
      Completer<Object?>().future;
}
