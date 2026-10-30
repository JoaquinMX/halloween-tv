/// Full-screen camera QR capture for the join flow.
///
/// Pops with the first non-empty decoded string. A cancelled/closed screen
/// pops with null, which the caller treats as "scanner unavailable" so the
/// type-or-paste path stays usable. No payload parsing happens here: the
/// captured text goes through the same [parseGuestJoinPayload] validation
/// as pasted input.
///
/// Lifecycle: the [MobileScanner] widget auto-starts the controller once it
/// is attached and auto-stops it on dispose; this screen additionally pauses
/// the camera when the app backgrounds (the widget only observes lifecycle
/// for its own internal controller) and restarts it on foreground return.
/// Camera start failures surface through [errorBuilder] as a retryable
/// screen with a type-or-paste fallback instead of a black preview.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

final class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key});
  static const Key scannerKey = Key('qr-scanner-view');
  static const Key closeKey = Key('qr-scan-close');
  static const Key errorKey = Key('qr-scan-error');
  static const Key retryKey = Key('qr-scan-retry');
  static const Key manualEntryKey = Key('qr-scan-manual-entry');

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

final class _QrScanScreenState extends State<QrScanScreen>
    with WidgetsBindingObserver {
  late final MobileScannerController _controller;
  bool _done = false;
  bool _foreground = true;
  Future<void> _lifecycleOperation = Future<void>.value();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Created on the widget timeline so start (driven by the attached
    // MobileScanner widget) always runs after attachment; never start
    // from here, which would race the attach handshake.
    _controller = MobileScannerController(
      detectionSpeed: DetectionSpeed.noDuplicates,
      // The screen owns lifecycle transitions because the package only
      // observes them automatically for its internally-created controller.
      autoStart: false,
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // MobileScanner attaches the injected controller during its initState.
    // Starting on the next frame guarantees that attachment has happened.
    if (!_startScheduled) {
      _startScheduled = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _foreground && !_done) {
          unawaited(_startCamera());
        }
      });
    }
  }

  bool _startScheduled = false;

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_controller.dispose());
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.paused:
      case AppLifecycleState.inactive:
      case AppLifecycleState.hidden:
        _foreground = false;
        _lifecycleOperation = _lifecycleOperation
            .catchError((Object _) {})
            .then((_) => _controller.stop());
        unawaited(_lifecycleOperation);
      case AppLifecycleState.resumed:
        _foreground = true;
        if (_done || !mounted) {
          return;
        }
        _lifecycleOperation = _lifecycleOperation
            .catchError((Object _) {})
            .then((_) => _startCamera());
        unawaited(_lifecycleOperation);
      case AppLifecycleState.detached:
        break;
    }
  }

  /// Restarts a stopped camera on foreground return. Calling start when
  /// the camera is already running is a no-op; start races and
  /// post-dispose calls resolve to caught exceptions or state updates,
  /// and a failed start also surfaces through the scanner [errorBuilder]
  /// below, so nothing here can strand the screen.
  Future<void> _startCamera() async {
    if (!mounted || !_foreground || _done) {
      return;
    }
    try {
      await _controller.start();
    } on MobileScannerException {
      // Surfaced via MobileScannerState.error -> errorBuilder.
    } on Exception {
      // Same: the error screen keeps the type-or-paste path usable.
    }
  }

  Future<void> _retry() async {
    await _startCamera();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_done) {
      return;
    }
    for (final Barcode barcode in capture.barcodes) {
      final String? raw = barcode.rawValue;
      if (raw != null && raw.trim().isNotEmpty) {
        _done = true;
        Navigator.of(context).pop(raw);
        return;
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Scan join code'),
      leading: IconButton(
        key: QrScanScreen.closeKey,
        icon: const Icon(Icons.close),
        onPressed: () => Navigator.of(context).pop(),
      ),
    ),
    body: MobileScanner(
      key: QrScanScreen.scannerKey,
      controller: _controller,
      onDetect: _onDetect,
      errorBuilder: (BuildContext context, MobileScannerException error) =>
          _CameraErrorView(error: error, onRetry: _retry),
    ),
  );
}

/// Retryable camera-failure screen: the black preview is replaced by the
/// failure reason, a retry, and a fallback that pops back to the
/// type-or-paste path.
final class _CameraErrorView extends StatelessWidget {
  const _CameraErrorView({required this.error, required this.onRetry});

  final MobileScannerException error;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final String reason = switch (error.errorCode) {
      MobileScannerErrorCode.permissionDenied =>
        'Camera access was denied. Allow access and try again.',
      MobileScannerErrorCode.unsupported =>
        'This device cannot scan QR codes with the camera.',
      _ =>
        'The camera could not start. You can retry or enter the code manually.',
    };
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(Icons.videocam_off_outlined, size: 48),
            const SizedBox(height: 16),
            Text(
              reason,
              key: QrScanScreen.errorKey,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 16),
            ),
            const SizedBox(height: 16),
            ElevatedButton(
              key: QrScanScreen.retryKey,
              onPressed: () => unawaited(onRetry()),
              child: const Text('Retry camera'),
            ),
            const SizedBox(height: 8),
            TextButton(
              key: QrScanScreen.manualEntryKey,
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Enter code instead'),
            ),
          ],
        ),
      ),
    );
  }
}
