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

  test('rejects every scope mismatch and malformed shape', () async {
    const String party = 'party-1';
    const String device = 'p-0123456789abcdef0123456789abcdef';
    const String channel = 'cctv';
    Map<String, Object?> valid() => <String, Object?>{
      'partyId': party,
      'deviceId': device,
      'channelId': channel,
      'role': 'guest',
      'status': 'active',
      'created': true,
    };
    final List<Map<String, Object?> Function()> mutations = <Map<String, Object?> Function()>[
      () => valid()..['partyId'] = 'other',
      () => valid()..['deviceId'] = 'p-ffffffffffffffffffffffffffffffff',
      () => valid()..['channelId'] = 'other',
      () => valid()..['role'] = 'tv',
      () => valid()..['role'] = 'admin',
      () => valid()..['status'] = 'inactive',
      () => valid()..['created'] = 1,
      () => valid()..['created'] = 'true',
      () => valid()..remove('created'),
      () => valid()..remove('role'),
    ];
    expect(mutations, hasLength(10));
    for (final Map<String, Object?> Function() mutate in mutations) {
      final FakeJoinInvoker invoker = FakeJoinInvoker(mutate());
      await expectLater(
        PartyJoinClient(invoker: invoker).register(
          partyId: party,
          deviceId: device,
          channelId: channel,
        ),
        throwsFormatException,
        reason: 'mutated response ${mutate()} must throw',
      );
    }
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
