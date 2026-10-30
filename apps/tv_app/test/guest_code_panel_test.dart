/// P2: TV session QR + refreshed anonymous guest listing.
library;

import 'dart:async';
import 'dart:convert';

import 'package:channel_cctv/channel_cctv.dart';
import 'package:core_ui/core_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:testing_toolkit/testing_toolkit.dart';
import 'package:tv_app/src/wall/guest_code_panel.dart';
import 'package:tv_app/src/wall/guest_codes.dart';
import 'package:tv_app/src/wall/wall_screen.dart';

import 'support/fakes.dart';
import 'wall_test.dart'
    show pumpWall, teardownWall, wallHarness, wallManifest;

Map<String, Object?> listingResponse({
  String partyId = 'party-1',
  String channelId = hauntedSurveillanceChannelId,
  String tvDeviceId = 'tv-abc',
  Object? joinPin = const _Absent(),
  List<Object?> devices = const <Object?>[],
}) {
  final Map<String, Object?> map = <String, Object?>{
    'partyId': partyId,
    'channelId': channelId,
    'tvDeviceId': tvDeviceId,
    'devices': devices,
  };
  if (joinPin is! _Absent) {
    map['joinPin'] = joinPin;
  }
  return map;
}

class _Absent {
  const _Absent();
}

GuestCodeClient listingClient(
  Map<String, Object?> response, {
  List<Map<String, Object?>>? seenPayloads,
  String partyId = 'party-1',
  String tvDeviceId = 'tv-abc',
  String channelId = hauntedSurveillanceChannelId,
  Future<Map<String, Object?>> Function()? next,
  int callsBeforeNext = 0,
}) {
  int calls = 0;
  return GuestCodeClient(
    invoker: (String name, Map<String, Object?> payload) async {
      expect(name, 'listPartyDevices');
      seenPayloads?.add(Map<String, Object?>.of(payload));
      calls++;
      if (next != null && calls > callsBeforeNext) {
        return next();
      }
      return response;
    },
    partyId: partyId,
    deviceId: tvDeviceId,
    channelId: channelId,
  );
}

Future<void> pumpPanel(
  WidgetTester tester,
  GuestCodeClient client, {
  String tvDeviceId = 'tv-abc',
  Duration refreshInterval = const Duration(minutes: 5),
  VoidCallback? onBack,
  VoidCallback? onClose,
  FocusNode? primaryFocusNode,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: CctvTheme.dark(),
      home: Scaffold(
        body: GuestCodePanel(
          client: client,
          tvDeviceId: tvDeviceId,
          refreshInterval: refreshInterval,
          onBack: onBack,
          onClose: onClose ?? () {},
          primaryFocusNode: primaryFocusNode,
        ),
      ),
    ),
  );
}

Future<void> disposePanel(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
}

String qrDataOf(WidgetTester tester) {
  final QrImageView qr = tester.widget<QrImageView>(
    find.byKey(kGuestCodeQrKey),
  );
  return qr.semanticsLabel;
}

void main() {
  group('buildJoinPayload', () {
    test('omits absent PIN and contains exactly session keys', () {
      final String payload = buildJoinPayload(
        partyId: 'party-1',
        channelId: 'haunted_surveillance',
      );
      final Map<String, Object?> decoded =
          Map<String, Object?>.from(jsonDecode(payload) as Map);
      expect(decoded.keys.toSet(), <String>{'partyId', 'channelId'});
      expect(decoded['partyId'], 'party-1');
      expect(payload.contains('http'), isFalse);
      expect(payload.contains('deviceId'), isFalse);
    });

    test('includes six-digit PIN with leading zeros significant', () {
      final String payload = buildJoinPayload(
        partyId: 'party-1',
        channelId: 'c',
        joinPin: '004201',
      );
      final Map<String, Object?> decoded =
          Map<String, Object?>.from(jsonDecode(payload) as Map);
      expect(
        decoded,
        <String, Object?>{
          'partyId': 'party-1',
          'channelId': 'c',
          'joinPin': '004201',
        },
      );
      expect(decoded.keys.toSet(), <String>{'partyId', 'channelId', 'joinPin'});
    });

    test('rejects malformed PIN shapes', () {
      expect(
        () => buildJoinPayload(partyId: 'p', channelId: 'c', joinPin: '12345'),
        throwsArgumentError,
      );
      expect(
        () => buildJoinPayload(partyId: 'p', channelId: 'c', joinPin: 'abcdef'),
        throwsArgumentError,
      );
      expect(
        () =>
            buildJoinPayload(partyId: 'p', channelId: 'c', joinPin: '1234567'),
        throwsArgumentError,
      );
    });

    test('no caller uses the removed deviceId argument', () {
      // Compile-time proof: the old signature no longer exists. A dynamic
      // call with deviceId must fail.
      expect(
        () => (buildJoinPayload as dynamic)(
          partyId: 'p',
          deviceId: 'tv',
          channelId: 'c',
        ),
        throwsA(isA<NoSuchMethodError>()),
      );
    });
  });

  group('GuestCodeClient.fetchListing', () {
    test('parses scope + PIN + entries; request carries TV deviceId', () async {
      final List<Map<String, Object?>> seen = <Map<String, Object?>>[];
      final GuestCodeClient client = listingClient(
        listingResponse(
          joinPin: '004201',
          devices: <Object?>[
            <String, Object?>{
              'deviceId': 'g-1',
              'label': 'Guest 1',
              'role': 'guest',
              'status': 'active',
            },
            <String, Object?>{'deviceId': 'g-2'},
          ],
        ),
        seenPayloads: seen,
      );
      final GuestCodeListing listing = await client.fetchListing();
      expect(seen.single['deviceId'], 'tv-abc');
      expect(seen.single['partyId'], 'party-1');
      expect(listing.partyId, 'party-1');
      expect(listing.channelId, hauntedSurveillanceChannelId);
      expect(listing.tvDeviceId, 'tv-abc');
      expect(listing.joinPin, '004201');
      expect(listing.devices, hasLength(2));
      expect(listing.devices[0].label, 'Guest 1');
      expect(listing.devices[1].label, isNull);
      expect(listing.devices[1].displayLabel, 'Guest device');
      // Back-compat path still works.
      expect(await client.fetchGuestCodes(), listing.devices);
    });

    test('absent PIN means no PIN required', () async {
      final GuestCodeClient client = listingClient(listingResponse());
      final GuestCodeListing listing = await client.fetchListing();
      expect(listing.joinPin, isNull);
    });

    test('tolerates empty-string labels', () async {
      final GuestCodeClient client = listingClient(
        listingResponse(
          devices: <Object?>[
            <String, Object?>{'deviceId': 'g-1', 'label': ''},
            <String, Object?>{'deviceId': 'g-2', 'label': '   '},
          ],
        ),
      );
      final GuestCodeListing listing = await client.fetchListing();
      expect(listing.devices[0].label, isNull);
      expect(listing.devices[1].label, isNull);
    });

    test('rejects malformed scope/PIN/entries', () async {
      Future<void> expectBad(Map<String, Object?> response) async {
        await expectLater(
          listingClient(response).fetchListing(),
          throwsA(isA<GuestCodeException>()),
        );
      }

      await expectBad(<String, Object?>{'devices': <Object?>[]});
      await expectBad(
        listingResponse(devices: const <Object?>[], partyId: ''),
      );
      await expectBad(
        listingResponse(partyId: 'other-party'),
      );
      await expectBad(
        listingResponse(channelId: 'other-channel'),
      );
      await expectBad(
        listingResponse(tvDeviceId: 'tv-other'),
      );
      await expectBad(listingResponse(joinPin: '12345'));
      await expectBad(listingResponse(joinPin: 'abcdef'));
      await expectBad(listingResponse(joinPin: 123456));
      await expectBad(
        listingResponse(devices: <Object?>['nope']),
      );
      await expectBad(
        listingResponse(
          devices: <Object?>[
            <String, Object?>{'deviceId': '', 'label': 'x'},
          ],
        ),
      );
      await expectBad(
        listingResponse(
          devices: <Object?>[
            <String, Object?>{'label': 'x'},
          ],
        ),
      );
      await expectBad(
        listingResponse(
          devices: <Object?>[
            <String, Object?>{'deviceId': 'g-1', 'label': 42},
          ],
        ),
      );
      await expectBad(<String, Object?>{'nope': true});
    });
  });

  group('GuestCodePanel widget', () {
    testWidgets('shows TV code large with exactly one QR from session',
        (WidgetTester tester) async {
      final GuestCodeClient client = listingClient(
        listingResponse(
          joinPin: '004201',
          devices: <Object?>[
            <String, Object?>{'deviceId': 'g-1', 'label': 'Guest 1'},
          ],
        ),
      );
      await pumpPanel(tester, client, onBack: () {});
      await tester.pump();
      await tester.pump();
      expect(find.text('GUEST CODES'), findsOneWidget);
      expect(find.text('tv-abc'), findsOneWidget);
      expect(find.byType(QrImageView), findsOneWidget);
      final Map<String, Object?> decoded =
          Map<String, Object?>.from(jsonDecode(qrDataOf(tester)) as Map);
      expect(
        decoded,
        <String, Object?>{
          'partyId': 'party-1',
          'channelId': hauntedSurveillanceChannelId,
          'joinPin': '004201',
        },
      );
      expect(find.textContaining('004201'), findsWidgets);
      expect(find.text('Guest 1: g-1'), findsOneWidget);
      expect(find.byKey(kGuestCodeCloseKey), findsOneWidget);
      expect(find.byKey(kGuestCodeBackKey), findsOneWidget);
      await disposePanel(tester);
    });

    testWidgets('PIN-free session yields exact two-key QR + no-PIN text',
        (WidgetTester tester) async {
      final GuestCodeClient client = listingClient(listingResponse());
      await pumpPanel(tester, client);
      await tester.pump();
      await tester.pump();
      expect(find.byType(QrImageView), findsOneWidget);
      final Map<String, Object?> decoded =
          Map<String, Object?>.from(jsonDecode(qrDataOf(tester)) as Map);
      expect(decoded.keys.toSet(), <String>{'partyId', 'channelId'});
      expect(find.textContaining('no PIN required'), findsOneWidget);
      await disposePanel(tester);
    });

    testWidgets('label-absent rows use neutral fallback, id shown once',
        (WidgetTester tester) async {
      final GuestCodeClient client = listingClient(
        listingResponse(
          devices: <Object?>[
            <String, Object?>{'deviceId': 'g-9'},
            <String, Object?>{'deviceId': 'g-10', 'label': ''},
          ],
        ),
      );
      await pumpPanel(tester, client);
      await tester.pump();
      await tester.pump();
      expect(find.text('Guest device: g-9'), findsOneWidget);
      expect(find.text('Guest device: g-10'), findsOneWidget);
      // Never renders the id as both label and value.
      expect(find.text('g-9: g-9'), findsNothing);
      expect(find.text('g-10: g-10'), findsNothing);
      expect(find.textContaining('type them in'), findsNothing);
      expect(find.textContaining('dictat'), findsNothing);
      await disposePanel(tester);
    });

    testWidgets('loading shows no fabricated QR; error shows no QR',
        (WidgetTester tester) async {
      final Completer<Map<String, Object?>> gate =
          Completer<Map<String, Object?>>();
      final GuestCodeClient slow = GuestCodeClient(
        invoker: (_, __) => gate.future,
        partyId: 'party-1',
        deviceId: 'tv-abc',
        channelId: hauntedSurveillanceChannelId,
      );
      await pumpPanel(tester, slow);
      await tester.pump();
      expect(find.byKey(kGuestCodeLoadingKey), findsOneWidget);
      expect(find.byType(QrImageView), findsNothing);
      expect(find.text('tv-abc'), findsOneWidget);
      gate.completeError(const GuestCodeException('denied'));
      await tester.pump();
      await tester.pump();
      expect(find.byKey(kGuestCodeErrorKey), findsOneWidget);
      expect(find.textContaining('denied'), findsOneWidget);
      expect(find.byType(QrImageView), findsNothing);
      await disposePanel(tester);
    });

    testWidgets('empty list states no seed instructions',
        (WidgetTester tester) async {
      final GuestCodeClient client = listingClient(listingResponse());
      await pumpPanel(tester, client);
      await tester.pump();
      await tester.pump();
      expect(find.byKey(kGuestCodeEmptyKey), findsOneWidget);
      expect(find.textContaining('seed_guests'), findsNothing);
      expect(find.byType(QrImageView), findsOneWidget);
      await disposePanel(tester);
    });

    testWidgets('type-or-paste instructions with camera-deferred status',
        (WidgetTester tester) async {
      final GuestCodeClient client = listingClient(listingResponse());
      await pumpPanel(tester, client);
      await tester.pump();
      await tester.pump();
      expect(find.textContaining('type or paste'), findsOneWidget);
      expect(find.textContaining('Camera QR scanning'), findsOneWidget);
      expect(find.textContaining('reads codes aloud'), findsNothing);
      expect(find.textContaining('later slice'), findsNothing);
      await disposePanel(tester);
    });

    testWidgets('refresh after new joins updates rows + retains QR on failure',
        (WidgetTester tester) async {
      int calls = 0;
      final GuestCodeClient client = GuestCodeClient(
        invoker: (String name, Map<String, Object?> payload) async {
          calls++;
          if (calls == 1) {
            return listingResponse(
              devices: <Object?>[
                <String, Object?>{'deviceId': 'g-1', 'label': 'Guest 1'},
              ],
            );
          }
          if (calls == 2) {
            return listingResponse(
              devices: <Object?>[
                <String, Object?>{'deviceId': 'g-1', 'label': 'Guest 1'},
                <String, Object?>{'deviceId': 'g-2'},
              ],
            );
          }
          throw const GuestCodeException('flaky');
        },
        partyId: 'party-1',
        deviceId: 'tv-abc',
        channelId: hauntedSurveillanceChannelId,
      );
      await pumpPanel(
        tester,
        client,
        refreshInterval: const Duration(milliseconds: 50),
      );
      await tester.pump();
      await tester.pump();
      expect(find.text('Guest 1: g-1'), findsOneWidget);
      final String firstQr = qrDataOf(tester);

      await tester.pump(const Duration(milliseconds: 60));
      await tester.pump();
      await tester.pump();
      expect(find.text('Guest device: g-2'), findsOneWidget);

      await tester.pump(const Duration(milliseconds: 60));
      await tester.pump();
      await tester.pump();
      // Last valid session retained through the refresh failure.
      expect(find.byType(QrImageView), findsOneWidget);
      expect(qrDataOf(tester), firstQr);
      expect(find.text('Guest device: g-2'), findsOneWidget);
      expect(find.byKey(kGuestCodeErrorKey), findsOneWidget);
      expect(calls, greaterThanOrEqualTo(3));
      await disposePanel(tester);
    });

    testWidgets('overlapping refreshes never run concurrently',
        (WidgetTester tester) async {
      int calls = 0;
      final Completer<Map<String, Object?>> gate =
          Completer<Map<String, Object?>>();
      final GuestCodeClient client = GuestCodeClient(
        invoker: (_, __) {
          calls++;
          if (calls == 1) {
            return gate.future;
          }
          return Future.value(listingResponse());
        },
        partyId: 'party-1',
        deviceId: 'tv-abc',
        channelId: hauntedSurveillanceChannelId,
      );
      await pumpPanel(
        tester,
        client,
        refreshInterval: const Duration(milliseconds: 20),
      );
      await tester.pump();
      expect(calls, 1);
      // Periodic ticks while the first fetch is still in flight are skipped.
      await tester.pump(const Duration(milliseconds: 60));
      await tester.pump();
      expect(calls, 1);
      gate.complete(listingResponse());
      await tester.pump();
      await tester.pump();
      expect(find.byType(QrImageView), findsOneWidget);
      // The next tick after the in-flight fetch settled runs normally.
      await tester.pump(const Duration(milliseconds: 40));
      await tester.pump();
      await tester.pump();
      expect(calls, greaterThanOrEqualTo(2));
      await disposePanel(tester);
    });

    testWidgets('dispose cancels timer and ignores late responses',
        (WidgetTester tester) async {
      int calls = 0;
      final Completer<Map<String, Object?>> late =
          Completer<Map<String, Object?>>();
      final GuestCodeClient client = GuestCodeClient(
        invoker: (_, __) {
          calls++;
          if (calls == 1) {
            return late.future;
          }
          return Future.value(listingResponse());
        },
        partyId: 'party-1',
        deviceId: 'tv-abc',
        channelId: hauntedSurveillanceChannelId,
      );
      await pumpPanel(
        tester,
        client,
        refreshInterval: const Duration(milliseconds: 20),
      );
      await tester.pump();
      final int callsAtOpen = calls;
      expect(callsAtOpen, 1);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      late.complete(listingResponse());
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump();
      expect(calls, callsAtOpen);
      expect(tester.takeException(), isNull);
      // Already disposed; nothing further to tear down.
    });

    testWidgets('D-pad back/close keys invoke callbacks',
        (WidgetTester tester) async {
      bool backed = false;
      bool closed = false;
      final FocusNode primary = FocusNode(debugLabel: 'panel-primary');
      addTearDown(primary.dispose);
      final GuestCodeClient client = listingClient(listingResponse());
      await pumpPanel(
        tester,
        client,
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

    testWidgets('escape falls back to onClose when no onBack',
        (WidgetTester tester) async {
      bool closed = false;
      final FocusNode primary = FocusNode(debugLabel: 'panel-primary');
      addTearDown(primary.dispose);
      final GuestCodeClient client = listingClient(listingResponse());
      await pumpPanel(
        tester,
        client,
        onClose: () => closed = true,
        primaryFocusNode: primary,
      );
      await tester.pump();
      await tester.pump();
      expect(find.byKey(kGuestCodeBackKey), findsNothing);
      primary.requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(closed, isTrue);
      primary.unfocus();
      await disposePanel(tester);
    });

    testWidgets('1920x1080 layout smoke: no overflow, one QR',
        (WidgetTester tester) async {
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      final GuestCodeClient client = listingClient(
        listingResponse(
          joinPin: '123456',
          devices: <Object?>[
            <String, Object?>{'deviceId': 'g-1', 'label': 'Guest 1'},
          ],
        ),
      );
      await pumpPanel(tester, client, onBack: () {});
      await tester.pump();
      await tester.pump();
      expect(find.byType(QrImageView), findsOneWidget);
      expect(find.text('tv-abc'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await disposePanel(tester);
    });
  });

  group('WallScreen guest-code flow', () {
    GuestCodeClient fakeClient({bool fail = false, String? pin}) =>
        GuestCodeClient(
          invoker: (_, __) async {
            if (fail) {
              throw const GuestCodeException('denied');
            }
            return listingResponse(
              joinPin: pin ?? const _Absent(),
              devices: <Object?>[
                <String, Object?>{'deviceId': 'g-1', 'label': 'Guest 1'},
              ],
            );
          },
          partyId: 'party-1',
          deviceId: 'tv-abc',
          channelId: hauntedSurveillanceChannelId,
        );

    testWidgets('no client means no GUEST CODES button',
        (WidgetTester tester) async {
      final FakeClock clock = FakeClock(DateTime.utc(2026, 10, 31, 20));
      await tester.pumpWidget(
        wallHarness(
          manifest: wallManifest(),
          clock: clock,
          factory: fakeControllerFactory(),
        ),
      );
      await pumpWall(tester);

      await tester.sendKeyEvent(LogicalKeyboardKey.contextMenu);
      await tester.pump();
      await tester.pump();
      expect(find.byKey(kRecoveryOverlayKey), findsOneWidget);
      expect(find.text('GUEST CODES'), findsNothing);

      await tester.sendKeyEvent(LogicalKeyboardKey.contextMenu);
      await tester.pump();
      expect(find.byKey(kRecoveryOverlayKey), findsNothing);

      await teardownWall(tester);
    });

    testWidgets('GUEST CODES opens session QR panel, BACK returns',
        (WidgetTester tester) async {
      final FakeClock clock = FakeClock(DateTime.utc(2026, 10, 31, 20));
      await tester.pumpWidget(
        wallHarness(
          manifest: wallManifest(),
          clock: clock,
          factory: fakeControllerFactory(),
          guestCodeClient: fakeClient(pin: '004201'),
          partyId: 'party-1',
          tvDeviceId: 'tv-abc',
        ),
      );
      await pumpWall(tester);

      await tester.sendKeyEvent(LogicalKeyboardKey.contextMenu);
      await tester.pump();
      await tester.pump();
      await tester.tap(
        find.byKey(const ValueKey<String>('recovery-guest-codes')),
      );
      await tester.pump();
      await tester.pump();

      expect(find.byKey(kGuestCodePanelKey), findsOneWidget);
      expect(find.text('tv-abc'), findsOneWidget);
      expect(find.byType(QrImageView), findsOneWidget);
      final QrImageView qr = tester.widget<QrImageView>(
        find.byKey(kGuestCodeQrKey),
      );
      expect(
        Map<String, Object?>.from(jsonDecode(qr.semanticsLabel) as Map),
        <String, Object?>{
          'partyId': 'party-1',
          'channelId': hauntedSurveillanceChannelId,
          'joinPin': '004201',
        },
      );
      expect(find.text('Guest 1: g-1'), findsOneWidget);

      await tester.tap(find.byKey(kGuestCodeBackKey));
      await tester.pump();
      expect(find.byKey(kGuestCodePanelKey), findsNothing);
      expect(find.text('RETRY CACHED WALL'), findsOneWidget);

      await tester.sendKeyEvent(LogicalKeyboardKey.contextMenu);
      await tester.pump();
      expect(find.byKey(kRecoveryOverlayKey), findsNothing);

      await teardownWall(tester);
    });

    testWidgets('guest list failure shows error with no QR, TV code stays',
        (WidgetTester tester) async {
      final FakeClock clock = FakeClock(DateTime.utc(2026, 10, 31, 20));
      await tester.pumpWidget(
        wallHarness(
          manifest: wallManifest(),
          clock: clock,
          factory: fakeControllerFactory(),
          guestCodeClient: fakeClient(fail: true),
          partyId: 'party-1',
          tvDeviceId: 'tv-abc',
        ),
      );
      await pumpWall(tester);

      await tester.sendKeyEvent(LogicalKeyboardKey.contextMenu);
      await tester.pump();
      await tester.pump();
      await tester.tap(
        find.byKey(const ValueKey<String>('recovery-guest-codes')),
      );
      await tester.pump();
      await tester.pump();

      expect(find.text('tv-abc'), findsOneWidget);
      expect(find.textContaining('denied'), findsOneWidget);
      expect(find.byType(QrImageView), findsNothing);

      await teardownWall(tester);
    });
  });
}
