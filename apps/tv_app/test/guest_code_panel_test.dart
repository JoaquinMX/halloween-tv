/// Host guest-code panel tests: join payload shape, client parsing, panel
/// rendering, and the WallScreen recovery -> guest-codes -> back flow.
library;

import 'dart:convert';

import 'package:channel_cctv/channel_cctv.dart';
import 'package:core_ui/core_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:testing_toolkit/testing_toolkit.dart';
import 'package:tv_app/src/wall/guest_code_panel.dart';
import 'package:tv_app/src/wall/guest_codes.dart';
import 'package:tv_app/src/wall/wall_screen.dart';

import 'support/fakes.dart';
import 'wall_test.dart'
    show pumpWall, teardownWall, wallHarness, wallManifest;

void main() {
  group('join payload', () {
    test('encodes only the opaque identifiers as a JSON object', () {
      final String payload = buildJoinPayload(
        partyId: 'party-1',
        deviceId: 'tv-abc',
        channelId: 'haunted_surveillance',
      );
      expect(
        jsonDecode(payload),
        <String, Object?>{
          'partyId': 'party-1',
          'deviceId': 'tv-abc',
          'channelId': 'haunted_surveillance',
        },
      );
      expect(payload.contains('http'), isFalse);
    });
  });

  group('GuestCodeClient', () {
    const List<GuestCodeEntry> fakeGuests = <GuestCodeEntry>[
      GuestCodeEntry(deviceId: 'g-1', label: 'Guest 1'),
      GuestCodeEntry(deviceId: 'g-2', label: 'Guest 2'),
    ];

    test('parses the device list from the callable response', () async {
      final GuestCodeClient client = GuestCodeClient(
        invoker: (String name, Map<String, Object?> payload) async {
          expect(name, 'listPartyDevices');
          expect(payload['deviceId'], 'tv-abc');
          return <String, Object?>{
            'partyId': 'party-1',
            'channelId': 'haunted_surveillance',
            'devices': <Object?>[
              <String, Object?>{'deviceId': 'g-1', 'label': 'Guest 1'},
              <String, Object?>{'deviceId': 'g-2', 'label': 'Guest 2'},
            ],
          };
        },
        partyId: 'party-1',
        deviceId: 'tv-abc',
        channelId: 'haunted_surveillance',
      );
      expect(await client.fetchGuestCodes(), fakeGuests);
    });

    test('rejects malformed responses', () async {
      Future<List<GuestCodeEntry>> fetchWith(Object? devices) =>
          GuestCodeClient(
            invoker: (_, __) async => <String, Object?>{'devices': devices},
            partyId: 'p',
            deviceId: 'tv',
            channelId: 'c',
          ).fetchGuestCodes();
      await expectLater(fetchWith('nope'), throwsA(isA<GuestCodeException>()));
      await expectLater(
        fetchWith(<Object?>['nope']),
        throwsA(isA<GuestCodeException>()),
      );
      await expectLater(
        fetchWith(<Object?>[
          <String, Object?>{'deviceId': '', 'label': 'x'},
        ]),
        throwsA(isA<GuestCodeException>()),
      );
    });
  });

  group('GuestCodePanel widget', () {
    Future<void> pumpPanel(
      WidgetTester tester, {
      List<GuestCodeEntry>? guests,
      bool loading = false,
      String? error,
      VoidCallback? onBack,
    }) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: CctvTheme.dark(),
          home: Scaffold(
            body: GuestCodePanel(
              partyId: 'party-1',
              tvDeviceId: 'tv-abc123',
              channelId: 'haunted_surveillance',
              joinPayload: buildJoinPayload(
                partyId: 'party-1',
                deviceId: 'tv-abc123',
                channelId: 'haunted_surveillance',
              ),
              guests: guests,
              isLoadingGuests: loading,
              guestsError: error,
              onBack: onBack,
              onClose: () {},
            ),
          ),
        ),
      );
      await tester.pump();
    }

    testWidgets('shows the TV code large with QR and guest rows',
        (WidgetTester tester) async {
      await pumpPanel(
        tester,
        guests: const <GuestCodeEntry>[
          GuestCodeEntry(deviceId: 'g-1', label: 'Guest 1'),
        ],
        onBack: () {},
      );
      expect(find.text('GUEST CODES'), findsOneWidget);
      expect(find.text('tv-abc123'), findsOneWidget);
      expect(find.text('Guest 1: g-1'), findsOneWidget);
      expect(find.byKey(kGuestCodeCloseKey), findsOneWidget);
      expect(find.byKey(kGuestCodeBackKey), findsOneWidget);
    });

    testWidgets('covers loading, error, and empty states',
        (WidgetTester tester) async {
      await pumpPanel(tester, loading: true);
      expect(find.text('Loading guest codes…'), findsOneWidget);

      await pumpPanel(tester, error: 'boom');
      expect(find.textContaining('boom'), findsOneWidget);

      await pumpPanel(tester, guests: const <GuestCodeEntry>[]);
      expect(find.textContaining('No guest codes yet'), findsOneWidget);
      // TV code and QR stay visible in every state.
      expect(find.text('tv-abc123'), findsOneWidget);
    });
  });

  group('WallScreen guest-code flow', () {
    GuestCodeClient fakeClient({bool fail = false}) => GuestCodeClient(
          invoker: (_, __) async {
            if (fail) {
              throw const GuestCodeException('denied');
            }
            return <String, Object?>{
              'devices': <Object?>[
                <String, Object?>{'deviceId': 'g-1', 'label': 'Guest 1'},
              ],
            };
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

    testWidgets('GUEST CODES opens the panel, BACK returns',
        (WidgetTester tester) async {
      final FakeClock clock = FakeClock(DateTime.utc(2026, 10, 31, 20));
      await tester.pumpWidget(
        wallHarness(
          manifest: wallManifest(),
          clock: clock,
          factory: fakeControllerFactory(),
          guestCodeClient: fakeClient(),
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
      expect(find.text('Guest 1: g-1'), findsOneWidget);

      await tester.tap(find.byKey(kGuestCodeBackKey));
      await tester.pump();
      expect(find.byKey(kGuestCodePanelKey), findsNothing);
      expect(find.text('RETRY CACHED WALL'), findsOneWidget);

      // MENU closes the recovery overlay again.
      await tester.sendKeyEvent(LogicalKeyboardKey.contextMenu);
      await tester.pump();
      expect(find.byKey(kRecoveryOverlayKey), findsNothing);

      await teardownWall(tester);
    });

    testWidgets('guest list failure stays inline on the panel',
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

      // TV code and QR stay visible; the failure is inline.
      expect(find.text('tv-abc'), findsOneWidget);
      expect(find.textContaining('denied'), findsOneWidget);

      await teardownWall(tester);
    });
  });
}
