// Host session pairing-code forwarding (phone host-join fix).
//
// Exercises the REAL HostSession + REAL HostJoinClient; only the
// callable invoker boundaries are faked (no Firebase, no network).
import 'package:companion_app/src/data/host_join_client.dart';
import 'package:companion_app/src/data/host_media_client.dart';
import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:companion_app/src/session/host_session.dart';
import 'package:core_foundation/core_foundation.dart' show Ok, Result;
import 'package:flutter_test/flutter_test.dart';

const String kHostDeviceId = 'p-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const String kHostToken =
    'hi-0123456789abcdef0123456789abcdef0123456789abcdef01';

GuestJoinData hostData() {
  final Result<GuestJoinData> result = parseGuestJoinFields(
    partyId: 'party-1',
    localDeviceId: kHostDeviceId,
    channelId: 'cctv',
    role: JoinRole.host,
    inviteToken: kHostToken,
  );
  return (result as Ok<GuestJoinData>).value;
}

final class FakeHostJoinInvoker implements HostJoinCallableInvoker {
  int calls = 0;
  Map<String, Object?>? lastPayload;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    calls++;
    lastPayload = Map<String, Object?>.of(payload);
    return <String, Object?>{
      'partyId': payload['partyId'],
      'deviceId': payload['deviceId'],
      'channelId': payload['channelId'],
      'role': 'host',
      'status': 'active',
      'created': true,
    };
  }
}

final class FakeHostMediaInvoker implements HostMediaCallableInvoker {
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    if (name == kListHostVideos) {
      return const <String, Object?>{'videos': <Object?>[]};
    }
    throw StateError('unexpected callable $name');
  }
}

HostSession openSession(FakeHostJoinInvoker joinInvoker) {
  return HostSession(
    joinClient: HostJoinClient(invoker: joinInvoker),
    mediaClient: HostMediaClient(invoker: FakeHostMediaInvoker()),
  );
}

void main() {
  test('session forwards the exact pairing code to redeem', () async {
    final FakeHostJoinInvoker invoker = FakeHostJoinInvoker();
    final HostSession session = openSession(invoker);
    try {
      await session.join(hostData(), pairingCode: '123456');
      expect(invoker.calls, 1);
      expect(invoker.lastPayload?['pairingCode'], '123456');
      expect(invoker.lastPayload?['inviteToken'], kHostToken);
      expect(session.state.status, HostSessionStatus.ready);
    } finally {
      await session.dispose();
    }
  });

  test('redeem includes pairingCode in the callable payload', () async {
    final FakeHostJoinInvoker invoker = FakeHostJoinInvoker();
    await HostJoinClient(invoker: invoker).redeem(
      partyId: 'party-1',
      deviceId: kHostDeviceId,
      channelId: 'cctv',
      inviteToken: kHostToken,
      pairingCode: '654321',
    );
    expect(invoker.calls, 1);
    expect(invoker.lastPayload, <String, Object?>{
      'partyId': 'party-1',
      'deviceId': kHostDeviceId,
      'channelId': 'cctv',
      'inviteToken': kHostToken,
      'pairingCode': '654321',
    });
  });

  test('malformed pairing codes are rejected before any network call',
      () async {
    final FakeHostJoinInvoker invoker = FakeHostJoinInvoker();
    final HostJoinClient client = HostJoinClient(invoker: invoker);
    for (final String bad in <String>['12345', 'abcdef', '1234567', '']) {
      await expectLater(
        client.redeem(
          partyId: 'party-1',
          deviceId: kHostDeviceId,
          channelId: 'cctv',
          inviteToken: kHostToken,
          pairingCode: bad,
        ),
        throwsFormatException,
      );
    }
    expect(invoker.calls, 0);
  });

  test('legacy no-code join keeps the old payload shape', () async {
    final FakeHostJoinInvoker invoker = FakeHostJoinInvoker();
    final HostSession session = openSession(invoker);
    try {
      await session.join(hostData());
      expect(invoker.calls, 1);
      expect(invoker.lastPayload?.containsKey('pairingCode'), isFalse);
      expect(invoker.lastPayload?['inviteToken'], kHostToken);
      expect(session.state.status, HostSessionStatus.ready);
    } finally {
      await session.dispose();
    }
  });
}
