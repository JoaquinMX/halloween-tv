/// App-level tests: boot gate -> wall, and the no-wall status screen.
library;

import 'package:channel_retro_tv/channel_retro_tv.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kernel_app/kernel_app.dart';
import 'package:testing_toolkit/testing_toolkit.dart';
import 'package:tv_app/src/app.dart';
import 'package:tv_app/src/wall/wall_boot.dart';

import 'support/fakes.dart';

void main() {
  testWidgets('boots the kernel registry into the live 2x2 wall',
      (WidgetTester tester) async {
    final FakeClock clock = FakeClock(DateTime.utc(2026, 10, 31, 23, 59, 58));

    await tester.pumpWidget(
      HalloweenTvApp(
        boot: WallBoot(store: InMemoryManifestStore()),
        clock: clock,
        tileControllerFactory: fakeControllerFactory(),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 16));
    await tester.pump();

    expect(find.text(cctvSlots[0].defaultLabel), findsOneWidget);
    expect(find.text(cctvSlots[3].defaultLabel), findsOneWidget);
    expect(find.text('REC'), findsNWidgets(4));
    expect(find.text('23:59:58'), findsNWidgets(4));
    for (final String cameraId in <String>[
      'CAM-01',
      'CAM-02',
      'CAM-03',
      'CAM-04',
    ]) {
      expect(find.byKey(ValueKey<String>('video-surface-$cameraId')),
          findsOneWidget);
    }
    // The retro-horror stub is registered with the kernel but must not be
    // the active channel.
    expect(find.textContaining('Retro Horror'), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });

  testWidgets('shows an app-level status + retry when no wall is available',
      (WidgetTester tester) async {
    var registryBuilds = 0;

    ChannelRegistry onlyRetroStub() {
      registryBuilds++;
      final ChannelRegistry registry = ChannelRegistry();
      registry.register(const RetroHorrorPlugin());
      return registry;
    }

    await tester.pumpWidget(
      HalloweenTvApp(
        boot: WallBoot(
          store: InMemoryManifestStore(),
          registryFactory: onlyRetroStub,
        ),
        tileControllerFactory: fakeControllerFactory(),
      ),
    );

    // First frame is the app-level boot state, not a blank TV.
    expect(find.text('TUNING FEED…'), findsOneWidget);

    await tester.pump();
    await tester.pump();

    expect(find.text('NO WALL AVAILABLE'), findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('wall-unavailable-reason')),
      findsOneWidget,
    );

    // D-pad reachable retry re-runs the boot sequence.
    await tester.tap(find.byKey(const ValueKey<String>('wall-retry')));
    await tester.pump();
    await tester.pump();

    expect(registryBuilds, 2);
    expect(find.text('NO WALL AVAILABLE'), findsOneWidget);
  });
}
