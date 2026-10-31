/// Host invite panel tests: mint, pairing code, expiry, list + revoke.
///
/// Exercises the REAL panel + invite/device clients over fake callable
/// invokers (network boundary only): validation, QR payload shape, the
/// expiry ticker, BACK routing, and the label-only host list with its
/// confirm-then-revoke flow.
library;

import 'dart:async';
import 'dart:convert';

import 'package:core_foundation/core_foundation.dart';
import 'package:core_ui/core_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:tv_app/src/wall/host_code_panel.dart';
import 'package:tv_app/src/wall/host_codes.dart';

const String _party = 'party-1';
const String _channel = 'cctv';
const String _tv = 'tv-abc';
const String _token = 'hi-0123456789abcdef0123456789abcdef01';

Map<String, Object?> inviteResponse({
  String partyId = _party,
  String channelId = _channel,
  String inviteToken = _token,
  Object? pairingCode = '123456',
  String? expiresAt,
}) {
  final Map<String, Object?> map = <String, Object?>{
    'partyId': partyId,
    'channelId': channelId,
    'inviteToken': inviteToken,
    'expiresAt': expiresAt ?? DateTime.utc(2030, 1, 1).toIso8601String(),
  };
  if (pairingCode is! _Absent) {
    map['pairingCode'] = pairingCode;
  }
  return map;
}

class _Absent {
  const _Absent();
}

HostInviteClient inviteClient(
  Map<String, Object?> response, {
  List<Map<String, Object?>>? seenPayloads,
  Future<Map<String, Object?>> Function()? next,
  int callsBeforeNext = 0,
}) {
  int calls = 0;
  return HostInviteClient(
    invoker: (String name, Map<String, Object?> payload) async {
      expect(name, 'createHostInvite');
      seenPayloads?.add(Map<String, Object?>.of(payload));
      calls++;
      if (next != null && calls > callsBeforeNext) {
        return next();
      }
      return response;
    },
    partyId: _party,
    deviceId: _tv,
    channelId: _channel,
  );
}

Map<String, Object?> hostListingResponse({
  List<Object?> devices = const <Object?>[],
}) => <String, Object?>{
  'partyId': _party,
  'channelId': _channel,
  'tvDeviceId': _tv,
  'devices': devices,
};

Map<String, Object?> hostRow(String id, String label) => <String, Object?>{
  'deviceId': id,
  'label': label,
  'role': 'host',
  'status': 'active',
};

/// Fake host-management invoker: serves [devices] for `listPartyDevices`
/// and records `revokeHostDevice` calls, removing the target on success.
final class FakeHostDeviceInvoker {
  FakeHostDeviceInvoker(this.devices);

  List<Map<String, Object?>> devices;
  final List<Map<String, Object?>> seenPayloads = <Map<String, Object?>>[];
  final List<String> revoked = <String>[];
  Object? revokeFailure;

  Future<Map<String, Object?>> call(
    String name,
    Map<String, Object?> payload,
  ) async {
    seenPayloads.add(<String, Object?>{'call': name, ...payload});
    if (name == 'listPartyDevices') {
      return hostListingResponse(
        devices: <Object?>[
          for (final Map<String, Object?> d in devices)
            Map<String, Object?>.of(d),
        ],
      );
    }
    if (name == 'revokeHostDevice') {
      final Object? failure = revokeFailure;
      if (failure != null) {
        throw failure;
      }
      final String target = payload['targetDeviceId'] as String;
      revoked.add(target);
      devices = <Map<String, Object?>>[
        for (final Map<String, Object?> d in devices)
          if (d['deviceId'] != target) d,
      ];
      return <String, Object?>{'revokedDeviceId': target};
    }
    throw StateError('unexpected callable $name');
  }
}

HostDeviceClient deviceClient(FakeHostDeviceInvoker fake) => HostDeviceClient(
  invoker: fake.call,
  partyId: _party,
  deviceId: _tv,
  channelId: _channel,
);

Future<void> pumpPanel(
  WidgetTester tester,
  HostInviteClient client, {
  HostDeviceClient? devicesClient,
  VoidCallback? onBack,
  VoidCallback? onClose,
  FocusNode? primaryFocusNode,
  Clock clock = const SystemClock(),
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: CctvTheme.dark(),
      home: Scaffold(
        body: HostCodePanel(
          client: client,
          devicesClient: devicesClient,
          onBack: onBack,
          onClose: onClose ?? () {},
          primaryFocusNode: primaryFocusNode,
          clock: clock,
        ),
      ),
    ),
  );
}

Future<void> disposePanel(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
}

/// Taps a panel action, scrolling it into view first: the panel content
/// can exceed the 800x600 test viewport, and an offscreen tap would miss.
Future<void> tapPanelKey(WidgetTester tester, Key key) async {
  await tester.ensureVisible(find.byKey(key));
  await tester.pump();
  await tester.tap(find.byKey(key));
}

String qrDataOf(WidgetTester tester) {
  final QrImageView qr = tester.widget<QrImageView>(find.byKey(kHostCodeQrKey));
  return qr.semanticsLabel;
}

final class _FakeClock implements Clock {
  _FakeClock(this.current);
  DateTime current;
  @override
  DateTime now() => current;
}

void main() {
  group('buildHostJoinPayload', () {
    test('carries the pairing code alongside the invite capability', () {
      final String payload = buildHostJoinPayload(
        partyId: _party,
        channelId: _channel,
        inviteToken: _token,
        pairingCode: '123456',
      );
      final Map<String, Object?> decoded = Map<String, Object?>.from(
        jsonDecode(payload) as Map,
      );
      expect(decoded, <String, Object?>{
        'partyId': _party,
        'channelId': _channel,
        'inviteToken': _token,
        'role': 'host',
        'pairingCode': '123456',
      });
      expect(payload.contains(_tv), isFalse);
      expect(payload.contains('deviceId'), isFalse);
    });

    test('rejects malformed invite tokens and pairing codes', () {
      expect(
        () => buildHostJoinPayload(
          partyId: 'p',
          channelId: 'c',
          inviteToken: '123456',
        ),
        throwsArgumentError,
      );
      expect(
        () => buildHostJoinPayload(
          partyId: 'p',
          channelId: 'c',
          inviteToken: _token,
          pairingCode: '12345',
        ),
        throwsArgumentError,
      );
      expect(
        () => buildHostJoinPayload(
          partyId: 'p',
          channelId: 'c',
          inviteToken: _token,
          pairingCode: 'abcdef',
        ),
        throwsArgumentError,
      );
    });
  });

  group('HostInvite.fromResponse', () {
    test('parses the pairing code with the invite scope', () {
      final HostInvite invite = HostInvite.fromResponse(
        inviteResponse(),
        expectedPartyId: _party,
        expectedChannelId: _channel,
      );
      expect(invite.partyId, _party);
      expect(invite.inviteToken, _token);
      expect(invite.pairingCode, '123456');
    });

    test('rejects missing or malformed pairing codes', () async {
      Future<void> expectBad(Map<String, Object?> response) async {
        expect(
          () => HostInvite.fromResponse(
            response,
            expectedPartyId: _party,
            expectedChannelId: _channel,
          ),
          throwsA(isA<HostInviteException>()),
        );
      }

      await expectBad(inviteResponse(pairingCode: const _Absent()));
      await expectBad(inviteResponse(pairingCode: null));
      await expectBad(inviteResponse(pairingCode: '12345'));
      await expectBad(inviteResponse(pairingCode: 'abcdef'));
      await expectBad(inviteResponse(pairingCode: 123456));
      await expectBad(inviteResponse(inviteToken: '123456'));
      await expectBad(inviteResponse(partyId: 'other-party'));
    });
  });

  group('HostCodePanel widget', () {
    testWidgets('mint success shows one QR + pairing code, refreshed', (
      WidgetTester tester,
    ) async {
      int mints = 0;
      final HostInviteClient client = HostInviteClient(
        invoker: (_, __) async {
          mints++;
          return inviteResponse(pairingCode: '11111$mints');
        },
        partyId: _party,
        deviceId: _tv,
        channelId: _channel,
      );
      final FakeHostDeviceInvoker fakeDevices = FakeHostDeviceInvoker(
        <Map<String, Object?>>[],
      );
      await pumpPanel(
        tester,
        client,
        devicesClient: deviceClient(fakeDevices),
        onBack: () {},
      );
      await tester.pump();
      await tester.pump();

      expect(find.text('HOST QR'), findsOneWidget);
      expect(find.byKey(kHostCodeQrKey), findsOneWidget);
      // The pairing code is shown next to the QR and travels in it.
      expect(find.byKey(kHostPairingCodeKey), findsOneWidget);
      expect(find.text('111111'), findsOneWidget);
      final Map<String, Object?> decoded = Map<String, Object?>.from(
        jsonDecode(qrDataOf(tester)) as Map,
      );
      expect(decoded['role'], 'host');
      expect(decoded['pairingCode'], '111111');
      expect(decoded.containsKey('deviceId'), isFalse);
      expect(find.byKey(kHostCodeRefreshKey), findsOneWidget);

      // REFRESH re-mints: the pairing code refreshes with the invite.
      await tapPanelKey(tester, kHostCodeRefreshKey);
      await tester.pump();
      await tester.pump();
      expect(mints, 2);
      expect(find.text('111112'), findsOneWidget);
      expect(find.text('111111'), findsNothing);
      final Map<String, Object?> refreshed = Map<String, Object?>.from(
        jsonDecode(qrDataOf(tester)) as Map,
      );
      expect(refreshed['pairingCode'], '111112');
      await disposePanel(tester);
    });

    testWidgets('malformed mint shows error with no QR and no code', (
      WidgetTester tester,
    ) async {
      final HostInviteClient client = inviteClient(
        inviteResponse(pairingCode: const _Absent()),
      );
      await pumpPanel(tester, client);
      await tester.pump();
      await tester.pump();
      expect(find.byKey(kHostCodeErrorKey), findsOneWidget);
      expect(find.textContaining('pairing code is malformed'), findsOneWidget);
      expect(find.byType(QrImageView), findsNothing);
      expect(find.byKey(kHostPairingCodeKey), findsNothing);
      await disposePanel(tester);
    });

    testWidgets('loading shows no fabricated QR or code', (
      WidgetTester tester,
    ) async {
      final Completer<Map<String, Object?>> gate =
          Completer<Map<String, Object?>>();
      final HostInviteClient slow = HostInviteClient(
        invoker: (_, __) => gate.future,
        partyId: _party,
        deviceId: _tv,
        channelId: _channel,
      );
      await pumpPanel(tester, slow);
      await tester.pump();
      expect(find.byKey(kHostCodeLoadingKey), findsOneWidget);
      expect(find.byType(QrImageView), findsNothing);
      expect(find.byKey(kHostPairingCodeKey), findsNothing);
      gate.complete(inviteResponse());
      await tester.pump();
      await tester.pump();
      expect(find.byKey(kHostCodeQrKey), findsOneWidget);
      expect(find.byKey(kHostPairingCodeKey), findsOneWidget);
      await disposePanel(tester);
    });

    testWidgets('expiry ticker hides QR + code until refresh', (
      WidgetTester tester,
    ) async {
      final _FakeClock clock = _FakeClock(DateTime.utc(2026, 10, 31, 20));
      int mints = 0;
      final HostInviteClient client = HostInviteClient(
        invoker: (_, __) async {
          mints++;
          return inviteResponse(
            pairingCode: '22222$mints',
            expiresAt: clock
                .now()
                .add(const Duration(seconds: 2))
                .toIso8601String(),
          );
        },
        partyId: _party,
        deviceId: _tv,
        channelId: _channel,
      );
      await pumpPanel(tester, client, clock: clock);
      await tester.pump();
      await tester.pump();
      expect(find.byKey(kHostCodeQrKey), findsOneWidget);
      expect(find.text('222221'), findsOneWidget);

      // The invite lapses: the ticker hides the stale capability + code.
      clock.current = clock.current.add(const Duration(seconds: 5));
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      expect(find.byType(QrImageView), findsNothing);
      expect(find.byKey(kHostPairingCodeKey), findsNothing);
      expect(find.byKey(kHostCodeExpiryKey), findsOneWidget);

      // REFRESH mints a fresh invite with a fresh pairing code.
      await tapPanelKey(tester, kHostCodeRefreshKey);
      await tester.pump();
      await tester.pump();
      expect(mints, 2);
      expect(find.byKey(kHostCodeQrKey), findsOneWidget);
      expect(find.text('222222'), findsOneWidget);
      await disposePanel(tester);
    });

    testWidgets('D-pad back/close keys invoke callbacks', (
      WidgetTester tester,
    ) async {
      bool backed = false;
      bool closed = false;
      final FocusNode primary = FocusNode(debugLabel: 'panel-primary');
      addTearDown(primary.dispose);
      await pumpPanel(
        tester,
        inviteClient(inviteResponse()),
        onBack: () => backed = true,
        onClose: () => closed = true,
        primaryFocusNode: primary,
      );
      await tester.pump();
      await tester.pump();
      primary.requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(backed, isTrue);
      expect(closed, isFalse);
      await tester.sendKeyEvent(LogicalKeyboardKey.contextMenu);
      await tester.pump();
      expect(closed, isTrue);
      primary.unfocus();
      await disposePanel(tester);
    });

    testWidgets('escape falls back to onClose when no onBack', (
      WidgetTester tester,
    ) async {
      bool closed = false;
      final FocusNode primary = FocusNode(debugLabel: 'panel-primary');
      addTearDown(primary.dispose);
      await pumpPanel(
        tester,
        inviteClient(inviteResponse()),
        onClose: () => closed = true,
        primaryFocusNode: primary,
      );
      await tester.pump();
      await tester.pump();
      expect(find.byKey(kHostCodeBackKey), findsNothing);
      primary.requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(closed, isTrue);
      primary.unfocus();
      await disposePanel(tester);
    });

    testWidgets('host list shows labels only, never device ids', (
      WidgetTester tester,
    ) async {
      final FakeHostDeviceInvoker fakeDevices = FakeHostDeviceInvoker(
        <Map<String, Object?>>[
          hostRow('p-host-aaaaaaaa', 'Phone A'),
          hostRow('p-host-bbbbbbbb', 'Phone B'),
          <String, Object?>{
            'deviceId': 'g-1',
            'label': 'Guest 1',
            'role': 'guest',
            'status': 'active',
          },
        ],
      );
      await pumpPanel(
        tester,
        inviteClient(inviteResponse()),
        devicesClient: deviceClient(fakeDevices),
      );
      await tester.pump();
      await tester.pump();
      await tester.pump();

      expect(find.byKey(kHostDeviceListKey), findsOneWidget);
      expect(find.text('Phone A'), findsOneWidget);
      expect(find.text('Phone B'), findsOneWidget);
      // Guest rows never leak into the host list, and device ids are never
      // rendered anywhere in the panel.
      expect(find.text('Guest 1'), findsNothing);
      for (final String id in <String>[
        'p-host-aaaaaaaa',
        'p-host-bbbbbbbb',
        'g-1',
        _tv,
      ]) {
        expect(find.text(id), findsNothing, reason: 'id $id rendered');
        expect(
          find.textContaining(id),
          findsNothing,
          reason: 'id $id rendered as substring',
        );
      }
      await disposePanel(tester);
    });

    testWidgets('revoke confirms, then removes only after success', (
      WidgetTester tester,
    ) async {
      final FakeHostDeviceInvoker fakeDevices = FakeHostDeviceInvoker(
        <Map<String, Object?>>[
          hostRow('p-host-aaaaaaaa', 'Phone A'),
          hostRow('p-host-bbbbbbbb', 'Phone B'),
        ],
      );
      await pumpPanel(
        tester,
        inviteClient(inviteResponse()),
        devicesClient: deviceClient(fakeDevices),
      );
      await tester.pump();
      await tester.pump();
      await tester.pump();

      // CANCEL keeps the row and issues no revoke.
      await tapPanelKey(tester, HostCodePanel.revokeKeyFor('Phone A'));
      await tester.pumpAndSettle();
      expect(find.byKey(kHostRevokeDialogKey), findsOneWidget);
      expect(
        find.textContaining('Phone A'),
        findsWidgets,
        reason: 'dialog names the host label',
      );
      expect(find.textContaining('previews'), findsOneWidget);
      expect(find.textContaining('manifest'), findsOneWidget);
      await tapPanelKey(tester, kHostRevokeCancelKey);
      await tester.pumpAndSettle();
      expect(find.byKey(kHostRevokeDialogKey), findsNothing);
      expect(fakeDevices.revoked, isEmpty);
      expect(find.text('Phone A'), findsOneWidget);

      // Confirm revokes the opaque id and reconciles from the server list.
      await tapPanelKey(tester, HostCodePanel.revokeKeyFor('Phone A'));
      await tester.pumpAndSettle();
      await tapPanelKey(tester, kHostRevokeConfirmKey);
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(fakeDevices.revoked, <String>['p-host-aaaaaaaa']);
      final Map<String, Object?> revokeCall = fakeDevices.seenPayloads
          .lastWhere(
            (Map<String, Object?> p) => p['call'] == 'revokeHostDevice',
          );
      expect(revokeCall['targetDeviceId'], 'p-host-aaaaaaaa');
      expect(revokeCall['partyId'], _party);
      expect(find.text('Phone A'), findsNothing);
      expect(find.text('Phone B'), findsOneWidget);
      expect(find.byKey(kHostDeviceErrorKey), findsNothing);
      await disposePanel(tester);
    });

    testWidgets('revoke failure keeps the row with an inline error', (
      WidgetTester tester,
    ) async {
      final FakeHostDeviceInvoker fakeDevices = FakeHostDeviceInvoker(
        <Map<String, Object?>>[hostRow('p-host-aaaaaaaa', 'Phone A')],
      );
      fakeDevices.revokeFailure = const HostDeviceException('denied');
      await pumpPanel(
        tester,
        inviteClient(inviteResponse()),
        devicesClient: deviceClient(fakeDevices),
      );
      await tester.pump();
      await tester.pump();
      await tester.pump();

      await tapPanelKey(tester, HostCodePanel.revokeKeyFor('Phone A'));
      await tester.pumpAndSettle();
      await tapPanelKey(tester, kHostRevokeConfirmKey);
      await tester.pump();
      await tester.pump();
      // Selection kept until authoritative success: the row stays retryable.
      expect(find.text('Phone A'), findsOneWidget);
      expect(find.byKey(kHostDeviceErrorKey), findsOneWidget);
      expect(find.textContaining('denied'), findsOneWidget);
      await disposePanel(tester);
    });

    testWidgets('no devices client hides the host list section', (
      WidgetTester tester,
    ) async {
      await pumpPanel(tester, inviteClient(inviteResponse()));
      await tester.pump();
      await tester.pump();
      expect(find.byKey(kHostCodeQrKey), findsOneWidget);
      expect(find.text('ACTIVE HOSTS'), findsNothing);
      expect(find.byKey(kHostDeviceListKey), findsNothing);
      await disposePanel(tester);
    });
  });
}
