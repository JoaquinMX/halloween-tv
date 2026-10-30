import 'dart:async';

import 'package:channel_api/channel_api.dart';
import 'package:companion_app/src/companion_app.dart';
import 'package:companion_app/src/join/device_identity_store.dart';
import 'package:companion_app/src/join/guest_join_data.dart';
import 'package:companion_app/src/join/join_payload_scanner.dart';
import 'package:companion_app/src/join/qr_scan_screen.dart';
import 'package:companion_app/src/ui/join_screen.dart';
import 'package:core_foundation/core_foundation.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Granted-camera regressions for the join QR flow.
///
/// Only two boundaries are substituted: the permission gateway (fake
/// [CameraPermissionClient], or the permission method channel for the
/// shipped-hierarchy test) and the native camera platform (fake
/// [MobileScannerPlatform]). Every test below drives the REAL
/// [CameraJoinPayloadScanner], the REAL [QrScanScreen], and the REAL
/// [JoinScreen] validation/submission paths. The pre-fix production code
/// failed these: [CompanionApp] built the scanner with its own
/// above-[MaterialApp] context, so the post-grant push found no [Navigator]
/// and the camera never started.

final class _FakeScanner implements JoinPayloadScanner {
  _FakeScanner(this.result);
  final JoinPayloadScanResult result;
  @override
  Future<JoinPayloadScanResult> scan([BuildContext? context]) async => result;
}

/// Scriptable permission gateway that also records the check/request order
/// relative to the camera start (shared [events] log).
final class _FakePermissions implements CameraPermissionClient {
  _FakePermissions({
    required this.checkResult,
    this.requestResult,
    this.requestGate,
    List<String>? events,
  }) : events = events ?? <String>[];
  final CameraPermissionState checkResult;
  final CameraPermissionState? requestResult;
  final Completer<CameraPermissionState>? requestGate;
  final List<String> events;
  int requests = 0;

  @override
  Future<CameraPermissionState> check() async {
    events.add('check');
    return checkResult;
  }

  @override
  Future<CameraPermissionState> request() async {
    events.add('request');
    requests++;
    final Completer<CameraPermissionState>? gate = requestGate;
    if (gate != null) {
      return gate.future;
    }
    return requestResult ?? checkResult;
  }
}

/// Native-camera boundary fake: records start/stop/dispose, serves scripted
/// start failures, and emits captures into the controller's barcode stream.
final class _FakeScannerPlatform extends MobileScannerPlatform {
  _FakeScannerPlatform({List<String>? events}) : events = events ?? <String>[];
  final List<String> events;
  int startCalls = 0;
  int stopCalls = 0;
  int pauseCalls = 0;
  int disposeCalls = 0;
  MobileScannerException? startError;
  final StreamController<BarcodeCapture?> barcodes =
      StreamController<BarcodeCapture?>.broadcast();
  final StreamController<TorchState> torchStates =
      StreamController<TorchState>.broadcast();
  final StreamController<double> zoomScales =
      StreamController<double>.broadcast();

  void emit(String rawValue) {
    barcodes.add(
      BarcodeCapture(barcodes: <Barcode>[Barcode(rawValue: rawValue)]),
    );
  }

  @override
  Stream<BarcodeCapture?> get barcodesStream => barcodes.stream;

  @override
  Stream<TorchState> get torchStateStream => torchStates.stream;

  @override
  Stream<double> get zoomScaleStateStream => zoomScales.stream;

  @override
  Widget buildCameraView() =>
      const SizedBox(key: Key('fake-camera-view'), width: 64, height: 64);

  @override
  Future<MobileScannerViewAttributes> start(StartOptions startOptions) async {
    startCalls++;
    events.add('start');
    final MobileScannerException? error = startError;
    if (error != null) {
      throw error;
    }
    return const MobileScannerViewAttributes(
      cameraDirection: CameraFacing.back,
      currentTorchMode: TorchState.off,
      size: Size(640, 480),
      numberOfCameras: 1,
    );
  }

  @override
  Future<void> stop() async {
    stopCalls++;
  }

  @override
  Future<void> pause() async {
    pauseCalls++;
  }

  @override
  Future<void> dispose() async {
    disposeCalls++;
  }
}

/// Port-level fake: substitutes only the callable-boundary source.
final class _FakeManifestSource implements ManifestSource<PlaybackManifest> {
  final List<StreamController<PlaybackManifest>> controllers =
      <StreamController<PlaybackManifest>>[];

  @override
  Stream<PlaybackManifest> watchCurrent({
    required String partyId,
    required String channelId,
  }) {
    final StreamController<PlaybackManifest> controller =
        StreamController<PlaybackManifest>();
    controllers.add(controller);
    return controller.stream;
  }
}

PlaybackManifest _manifest({int version = 1}) {
  String sha(String seed) => List.filled(64, seed).join();
  return PlaybackManifest(
    partyId: 'party-1',
    channelId: 'cctv',
    version: version,
    clips: <ClipDescriptor>[
      for (int i = 1; i <= 4; i++)
        ClipDescriptor(
          id: 'clip-$i',
          cameraId: 'CAM-0$i',
          storageObjectId: 'cctv/cam-0$i.mp4',
          sha256: sha('$i'),
          sizeBytes: 1024,
          duration: const Duration(seconds: 8),
          mimeType: 'video/mp4',
        ),
    ],
    publishedAt: DateTime.utc(2026, 10, 29, 14),
  );
}

const String _kDeviceId = 'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/// Flushes async stream delivery without pumpAndSettle (spinners schedule
/// endless frames, so fixed pumps only).
Future<void> _flush(WidgetTester tester) async {
  for (int i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Future<void> _pumpJoin(
  WidgetTester tester,
  JoinPayloadScanner scanner,
  void Function(GuestJoinData data) onJoin,
) async {
  SharedPreferences.setMockInitialValues(<String, Object>{
    DeviceIdentityStore.storageKey: _kDeviceId,
  });
  await tester.pumpWidget(
    MaterialApp(
      home: JoinScreen(scanner: scanner, onJoin: (data) async => onJoin(data)),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _tapScan(WidgetTester tester) async {
  await tester.ensureVisible(find.byKey(JoinScreen.scanKey));
  await tester.pump(const Duration(milliseconds: 50));
  final ScrollableState scrollable = tester.state<ScrollableState>(
    find.byType(Scrollable).first,
  );
  final Rect rect = tester.getRect(find.byKey(JoinScreen.scanKey));
  final double viewHeight =
      tester.view.physicalSize.height / tester.view.devicePixelRatio;
  final double pixels = scrollable.position.pixels;
  final double max = scrollable.position.maxScrollExtent;
  if (rect.bottom > viewHeight - 4.0) {
    final double delta = rect.bottom - viewHeight + 80.0;
    scrollable.position.jumpTo((pixels + delta).clamp(0.0, max).toDouble());
    await tester.pump(const Duration(milliseconds: 50));
  }
  await tester.tap(find.byKey(JoinScreen.scanKey));
}

Future<void> _enterPayload(WidgetTester tester, String text) async {
  await tester.ensureVisible(find.byKey(JoinScreen.payloadFieldKey));
  await tester.pump(const Duration(milliseconds: 50));
  await tester.enterText(find.byKey(JoinScreen.payloadFieldKey), text);
}

/// Pushes a real [QrScanScreen] over a bare host route; [onPop] receives
/// the value it pops with.
Future<void> _pushScanScreen(
  WidgetTester tester,
  void Function(String? value) onPop,
) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (BuildContext context) => Scaffold(
          body: Center(
            child: TextButton(
              key: const Key('open-scanner'),
              onPressed: () {
                Navigator.of(context)
                    .push<String>(
                      MaterialPageRoute(builder: (_) => const QrScanScreen()),
                    )
                    .then(onPop);
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const Key('open-scanner')));
  await tester.pumpAndSettle();
  expect(find.byType(QrScanScreen), findsOneWidget);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MobileScannerPlatform savedPlatform;
  late _FakeScannerPlatform camera;

  setUp(() {
    savedPlatform = MobileScannerPlatform.instance;
    camera = _FakeScannerPlatform();
    MobileScannerPlatform.instance = camera;
    MobileScannerController.resetPlatformSessionOwner();
  });

  tearDown(() async {
    MobileScannerPlatform.instance = savedPlatform;
    MobileScannerController.resetPlatformSessionOwner();
    await camera.barcodes.close();
    await camera.torchStates.close();
    await camera.zoomScales.close();
  });

  testWidgets(
    'denied-to-granted permission opens the real scanner and starts the camera',
    (tester) async {
      final List<String> events = <String>[];
      camera.events.clear();
      final _FakePermissions permissions = _FakePermissions(
        checkResult: CameraPermissionState.denied,
        requestResult: CameraPermissionState.granted,
        events: events,
      );
      GuestJoinData? received;
      await _pumpJoin(
        tester,
        CameraJoinPayloadScanner(permissions: permissions),
        (data) => received = data,
      );

      await _tapScan(tester);
      await tester.pumpAndSettle();

      // Permission was requested exactly once, then the camera started after
      // the grant — and the real scan screen is up with a live preview.
      expect(permissions.requests, 1);
      expect(events, <String>['check', 'request']);
      expect(camera.startCalls, 1);
      expect(find.byType(QrScanScreen), findsOneWidget);
      expect(find.byKey(QrScanScreen.scannerKey), findsOneWidget);
      expect(find.byKey(const Key('fake-camera-view')), findsOneWidget);
      expect(received, isNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('granted scan submits through the same validation as paste', (
    tester,
  ) async {
    GuestJoinData? received;
    await _pumpJoin(
      tester,
      CameraJoinPayloadScanner(
        permissions: _FakePermissions(
          checkResult: CameraPermissionState.granted,
        ),
      ),
      (data) => received = data,
    );

    await _tapScan(tester);
    await tester.pumpAndSettle();
    expect(find.byType(QrScanScreen), findsOneWidget);

    camera.emit('{"partyId":"qr-party","channelId":"cctv","joinPin":"123456"}');
    await tester.pumpAndSettle();

    // Detection pops the scanner and the text flows through the shared
    // parser + first-join submission.
    expect(find.byType(QrScanScreen), findsNothing);
    expect(received?.partyId.value, 'qr-party');
    expect(received?.channelId, 'cctv');
    expect(received?.joinPin, '123456');
    expect(find.byKey(JoinScreen.errorKey), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'scanned garbage surfaces the same parse error as pasted garbage',
    (tester) async {
      var called = false;
      await _pumpJoin(
        tester,
        _FakeScanner(const JoinPayloadText('{"nope":1}')),
        (_) => called = true,
      );
      await _tapScan(tester);
      await tester.pumpAndSettle();
      expect(called, isFalse);
      expect(find.byKey(JoinScreen.errorKey), findsOneWidget);
      expect(
        find.text('join payload must contain string partyId and channelId'),
        findsOneWidget,
      );
    },
  );

  testWidgets('duplicate detections pop only once with the first payload', (
    tester,
  ) async {
    String? popped;
    var pops = 0;
    await _pushScanScreen(tester, (String? value) {
      pops++;
      popped = value;
    });
    expect(camera.startCalls, 1);

    camera.emit('{"partyId":"first","channelId":"cctv"}');
    camera.emit('{"partyId":"second","channelId":"cctv"}');
    await tester.pumpAndSettle();

    // Exactly one pop: the screen is gone and no second route was pushed.
    expect(find.byType(QrScanScreen), findsNothing);
    expect(pops, 1);
    expect(popped, '{"partyId":"first","channelId":"cctv"}');
    expect(camera.startCalls, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('background stops the camera and resume restarts it', (
    tester,
  ) async {
    String? popped;
    await _pushScanScreen(tester, (String? value) => popped = value);
    expect(camera.startCalls, 1);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    expect(camera.stopCalls, greaterThanOrEqualTo(1));

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(camera.startCalls, 2);

    // Detection still works after the resume cycle.
    camera.emit('{"partyId":"resume","channelId":"cctv"}');
    await tester.pumpAndSettle();
    expect(find.byType(QrScanScreen), findsNothing);
    expect(popped, '{"partyId":"resume","channelId":"cctv"}');
    expect(tester.takeException(), isNull);
  });

  testWidgets('close and reopen starts a fresh camera session', (tester) async {
    GuestJoinData? received;
    await _pumpJoin(
      tester,
      CameraJoinPayloadScanner(
        permissions: _FakePermissions(
          checkResult: CameraPermissionState.granted,
        ),
      ),
      (data) => received = data,
    );

    await _tapScan(tester);
    await tester.pumpAndSettle();
    expect(find.byType(QrScanScreen), findsOneWidget);
    expect(camera.startCalls, 1);

    await tester.tap(find.byKey(QrScanScreen.closeKey));
    await tester.pumpAndSettle();
    expect(find.byType(QrScanScreen), findsNothing);
    expect(find.byKey(JoinScreen.scanKey), findsOneWidget);
    expect(received, isNull);

    await _tapScan(tester);
    await tester.pumpAndSettle();
    expect(find.byType(QrScanScreen), findsOneWidget);
    expect(camera.startCalls, 2);
    expect(tester.takeException(), isNull);
  });

  testWidgets('cancellation falls back without pushing a second scanner', (
    tester,
  ) async {
    var calls = 0;
    await _pumpJoin(
      tester,
      CameraJoinPayloadScanner(
        permissions: _FakePermissions(
          checkResult: CameraPermissionState.granted,
        ),
      ),
      (_) => calls++,
    );

    await _tapScan(tester);
    await tester.pumpAndSettle();
    expect(camera.startCalls, 1);

    await tester.tap(find.byKey(QrScanScreen.closeKey));
    await tester.pumpAndSettle();

    expect(calls, 0);
    expect(camera.startCalls, 1);
    expect(find.byType(QrScanScreen), findsNothing);
    expect(find.text('Scanner is unavailable on this device.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('camera start failure shows retry and manual-entry fallback', (
    tester,
  ) async {
    camera.startError = const MobileScannerException(
      errorCode: MobileScannerErrorCode.unsupported,
    );
    GuestJoinData? received;
    await _pumpJoin(
      tester,
      CameraJoinPayloadScanner(
        permissions: _FakePermissions(
          checkResult: CameraPermissionState.granted,
        ),
      ),
      (data) => received = data,
    );

    await _tapScan(tester);
    await tester.pumpAndSettle();

    expect(find.byKey(QrScanScreen.errorKey), findsOneWidget);
    expect(find.byKey(QrScanScreen.retryKey), findsOneWidget);

    // Retry with a working camera recovers the preview.
    camera.startError = null;
    await tester.tap(find.byKey(QrScanScreen.retryKey));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('fake-camera-view')), findsOneWidget);

    // A later failure (here: resume with a dead camera) resurfaces the
    // error screen, whose manual-entry fallback pops back to the usable
    // paste path.
    camera.startError = const MobileScannerException(
      errorCode: MobileScannerErrorCode.unsupported,
    );
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(find.byKey(QrScanScreen.errorKey), findsOneWidget);
    await tester.tap(find.byKey(QrScanScreen.manualEntryKey));
    await tester.pumpAndSettle();
    expect(find.byType(QrScanScreen), findsNothing);
    expect(find.text('Scanner is unavailable on this device.'), findsOneWidget);

    await _enterPayload(tester, '{"partyId":"paste","channelId":"cctv"}');
    await tester.ensureVisible(find.byKey(JoinScreen.submitKey));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(JoinScreen.submitKey));
    await tester.pumpAndSettle();
    expect(received?.partyId.value, 'paste');
    expect(tester.takeException(), isNull);
  });

  testWidgets('disposing the join screen while permission is pending is safe', (
    tester,
  ) async {
    final Completer<CameraPermissionState> gate =
        Completer<CameraPermissionState>();
    await _pumpJoin(
      tester,
      CameraJoinPayloadScanner(
        permissions: _FakePermissions(
          checkResult: CameraPermissionState.denied,
          requestGate: gate,
        ),
      ),
      (_) {},
    );

    await _tapScan(tester);
    await tester.pump();

    // Tear down the whole tree while the OS permission prompt is "up".
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
    gate.complete(CameraPermissionState.granted);
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
  });

  testWidgets('camera denial is graceful and keeps the paste path usable', (
    tester,
  ) async {
    GuestJoinData? received;
    await _pumpJoin(
      tester,
      _FakeScanner(const JoinPayloadPermissionDenied()),
      (data) => received = data,
    );
    await _tapScan(tester);
    await tester.pumpAndSettle();
    expect(received, isNull);
    expect(
      find.text(
        'Camera permission is needed to scan QR codes. Allow access and try again, or paste the join data instead.',
      ),
      findsOneWidget,
    );
    await _enterPayload(tester, '{"partyId":"paste","channelId":"cctv"}');
    await tester.ensureVisible(find.byKey(JoinScreen.submitKey));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(JoinScreen.submitKey));
    await tester.pumpAndSettle();
    expect(received?.partyId.value, 'paste');
  });

  testWidgets('permanent denial points at Settings', (tester) async {
    var called = false;
    await _pumpJoin(
      tester,
      _FakeScanner(const JoinPayloadPermissionDenied(permanently: true)),
      (_) => called = true,
    );
    await _tapScan(tester);
    await tester.pumpAndSettle();
    expect(called, isFalse);
    expect(find.textContaining('Settings'), findsOneWidget);
  });

  test(
    'camera scanner returns denial without requesting twice or navigating',
    () async {
      // check() denied -> request() denied: surfaces a retryable denial.
      final retryable = _FakePermissions(
        checkResult: CameraPermissionState.denied,
        requestResult: CameraPermissionState.denied,
      );
      // (No navigation happens on denial paths.)
      final scanner = CameraJoinPayloadScanner(
        contextOf: () => throw StateError('must not need context on denial'),
        permissions: retryable,
      );
      final first = await scanner.scan();
      expect(first, isA<JoinPayloadPermissionDenied>());
      expect((first as JoinPayloadPermissionDenied).permanently, isFalse);
      expect(retryable.requests, 1);

      // check() permanently denied: never prompts, never navigates.
      final blocked = _FakePermissions(
        checkResult: CameraPermissionState.permanentlyDenied,
      );
      final scanner2 = CameraJoinPayloadScanner(
        contextOf: () => throw StateError('must not need context on denial'),
        permissions: blocked,
      );
      final second = await scanner2.scan();
      expect(second, isA<JoinPayloadPermissionDenied>());
      expect((second as JoinPayloadPermissionDenied).permanently, isTrue);
      expect(blocked.requests, 0);
    },
  );

  test(
    'granted scan with no usable context falls back instead of throwing',
    () async {
      final scanner = CameraJoinPayloadScanner(
        permissions: _FakePermissions(
          checkResult: CameraPermissionState.granted,
        ),
      );
      // No invocation context and no legacy supplier: no Navigator anywhere.
      final result = await scanner.scan();
      expect(result, isA<JoinPayloadUnavailable>());
    },
  );

  group('shipped CompanionApp hierarchy', () {
    const MethodChannel permissionChannel = MethodChannel(
      'flutter.baseflow.com/permissions/methods',
    );
    late _FakeManifestSource source;

    void mockPermission({required int check, int request = 1}) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(permissionChannel, (MethodCall call) async {
            if (call.method == 'checkPermissionStatus') {
              return check;
            }
            if (call.method == 'requestPermissions') {
              return <int, int>{1: request};
            }
            return null;
          });
    }

    setUp(() {
      source = _FakeManifestSource();
    });

    tearDown(() async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(permissionChannel, null);
      for (final StreamController<PlaybackManifest> controller
          in source.controllers) {
        if (!controller.isClosed) {
          await controller.close();
        }
      }
    });

    Future<void> pumpShippedApp(WidgetTester tester) async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        DeviceIdentityStore.storageKey: _kDeviceId,
      });
      await tester.pumpWidget(
        CompanionApp(manifestSource: source, clock: const SystemClock()),
      );
      await _flush(tester);
    }

    testWidgets(
      'denied-to-granted permission starts the camera from the shipped tree',
      (tester) async {
        // First check: denied. Request: granted. Only the permission
        // boundary is mocked; the scanner, screen, and camera controller
        // are the shipped production objects.
        mockPermission(check: 0, request: 1);
        await pumpShippedApp(tester);
        expect(find.byKey(JoinScreen.scanKey), findsOneWidget);

        await _tapScan(tester);
        await tester.pumpAndSettle();

        // Pre-fix this push threw (ancestor context has no Navigator) and
        // the camera never started. Now the real screen is up and running.
        expect(find.byType(QrScanScreen), findsOneWidget);
        expect(camera.startCalls, 1);
        expect(find.byKey(const Key('fake-camera-view')), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('shipped scan reaches the joined lineup', (tester) async {
      mockPermission(check: 1);
      await pumpShippedApp(tester);

      await _tapScan(tester);
      await tester.pumpAndSettle();
      expect(find.byType(QrScanScreen), findsOneWidget);

      camera.emit('{"partyId":"party-1","channelId":"cctv"}');
      await _flush(tester);
      expect(source.controllers, hasLength(1));

      source.controllers.single.add(_manifest(version: 7));
      await _flush(tester);

      expect(find.textContaining('Manifest version 7'), findsOneWidget);
      expect(find.text('CAM-01 · hallway'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
