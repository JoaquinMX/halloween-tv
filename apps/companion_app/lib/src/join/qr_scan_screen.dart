/// Full-screen camera QR capture for the join flow.
///
/// Pops with the first non-empty decoded string. A cancelled/closed screen
/// pops with null, which the caller treats as "scanner unavailable" so the
/// type-or-paste path stays usable. No payload parsing happens here: the
/// captured text goes through the same [parseGuestJoinPayload] validation
/// as pasted input.
library;

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

final class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key});
  static const Key scannerKey = Key('qr-scanner-view');
  static const Key closeKey = Key('qr-scan-close');

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

final class _QrScanScreenState extends State<QrScanScreen> {
  final MobileScannerController _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  bool _done = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_done) return;
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
    ),
  );
}
