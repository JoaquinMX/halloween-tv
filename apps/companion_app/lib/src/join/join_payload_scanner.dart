/// Scanner seam for the join QR flow.
///
/// [JoinScreen] talks only to [JoinPayloadScanner]. Widget tests inject
/// fakes; the shipped app injects [CameraJoinPayloadScanner], which asks
/// for camera permission (graceful denial) and pushes [QrScanScreen].
library;

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import 'package:companion_app/src/join/qr_scan_screen.dart';

/// Result of one scan attempt.
sealed class JoinPayloadScanResult {
  const JoinPayloadScanResult();
}

/// A QR payload was captured; the raw text still goes through the same
/// [parseGuestJoinPayload] validation as the type-or-paste path.
final class JoinPayloadText extends JoinPayloadScanResult {
  const JoinPayloadText(this.text);
  final String text;
}

/// No scanner is available on this device, or the user cancelled the scan.
/// The type-or-paste path stays usable.
final class JoinPayloadUnavailable extends JoinPayloadScanResult {
  const JoinPayloadUnavailable();
}

/// Camera permission was denied. When [permanently] is true the OS will no
/// longer show the prompt, so the message must point at Settings.
final class JoinPayloadPermissionDenied extends JoinPayloadScanResult {
  const JoinPayloadPermissionDenied({this.permanently = false});
  final bool permanently;
}

abstract interface class JoinPayloadScanner {
  Future<JoinPayloadScanResult> scan();
}

final class UnavailableJoinPayloadScanner implements JoinPayloadScanner {
  const UnavailableJoinPayloadScanner();
  @override
  Future<JoinPayloadScanResult> scan() async => const JoinPayloadUnavailable();
}

/// Camera-permission states, decoupled from `permission_handler` for tests.
enum CameraPermissionState { granted, denied, permanentlyDenied }

/// Permission gateway seam; the shipped implementation delegates to
/// `permission_handler`, tests inject fakes.
abstract interface class CameraPermissionClient {
  Future<CameraPermissionState> check();
  Future<CameraPermissionState> request();
}

final class PermissionHandlerCameraPermissions implements CameraPermissionClient {
  const PermissionHandlerCameraPermissions();

  @override
  Future<CameraPermissionState> check() async => _map(await Permission.camera.status);

  @override
  Future<CameraPermissionState> request() async => _map(await Permission.camera.request());

  CameraPermissionState _map(PermissionStatus status) {
    if (status.isGranted || status.isLimited) return CameraPermissionState.granted;
    if (status.isPermanentlyDenied || status.isRestricted) {
      return CameraPermissionState.permanentlyDenied;
    }
    return CameraPermissionState.denied;
  }
}

/// Camera-backed scanner: permission flow with graceful denial, then a
/// full-screen [QrScanScreen] whose captured text reuses the existing
/// first-join registration and error states in [JoinScreen].
final class CameraJoinPayloadScanner implements JoinPayloadScanner {
  CameraJoinPayloadScanner({
    required BuildContext Function() contextOf,
    CameraPermissionClient permissions = const PermissionHandlerCameraPermissions(),
  }) : _contextOf = contextOf,
       _permissions = permissions;

  final BuildContext Function() _contextOf;
  final CameraPermissionClient _permissions;

  @override
  Future<JoinPayloadScanResult> scan() async {
    CameraPermissionState state = await _permissions.check();
    if (state == CameraPermissionState.denied) {
      state = await _permissions.request();
    }
    switch (state) {
      case CameraPermissionState.granted:
        break;
      case CameraPermissionState.denied:
        return const JoinPayloadPermissionDenied();
      case CameraPermissionState.permanentlyDenied:
        return const JoinPayloadPermissionDenied(permanently: true);
    }
    final String? text = await Navigator.of(
      _contextOf(),
    ).push<String>(MaterialPageRoute(builder: (_) => const QrScanScreen()));
    if (text == null || text.trim().isEmpty) {
      return const JoinPayloadUnavailable();
    }
    return JoinPayloadText(text);
  }
}
