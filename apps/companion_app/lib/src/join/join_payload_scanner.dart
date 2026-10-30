/// Scanner seam for the join QR flow.
///
/// [JoinScreen] talks only to [JoinPayloadScanner]. Widget tests inject
/// fakes; the shipped app injects [CameraJoinPayloadScanner], which asks
/// for camera permission (graceful denial) and pushes [QrScanScreen].
///
/// Navigation always uses the [BuildContext] supplied at scan invocation:
/// that context belongs to [JoinScreen], which lives below the app's
/// [MaterialApp], so [Navigator.of] resolves. A stale ancestor context
/// (for example the root widget's own build context, captured above
/// [MaterialApp]) has no [Navigator] and must never be used for the push.
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
  /// Runs one scan attempt. When [context] — a descendant of the app's
  /// [MaterialApp], supplied by [JoinScreen] at invocation — is provided it
  /// is used for any navigation; otherwise the scanner falls back to its
  /// own context supplier. Never retain the context beyond the future.
  Future<JoinPayloadScanResult> scan([BuildContext? context]);
}

final class UnavailableJoinPayloadScanner implements JoinPayloadScanner {
  const UnavailableJoinPayloadScanner();
  @override
  Future<JoinPayloadScanResult> scan([BuildContext? context]) async =>
      const JoinPayloadUnavailable();
}

/// Camera-permission states, decoupled from `permission_handler` for tests.
enum CameraPermissionState { granted, denied, permanentlyDenied }

/// Permission gateway seam; the shipped implementation delegates to
/// `permission_handler`, tests inject fakes.
abstract interface class CameraPermissionClient {
  Future<CameraPermissionState> check();
  Future<CameraPermissionState> request();
}

final class PermissionHandlerCameraPermissions
    implements CameraPermissionClient {
  const PermissionHandlerCameraPermissions();

  @override
  Future<CameraPermissionState> check() async =>
      _map(await Permission.camera.status);

  @override
  Future<CameraPermissionState> request() async =>
      _map(await Permission.camera.request());

  CameraPermissionState _map(PermissionStatus status) {
    if (status.isGranted || status.isLimited) {
      return CameraPermissionState.granted;
    }
    if (status.isPermanentlyDenied || status.isRestricted) {
      return CameraPermissionState.permanentlyDenied;
    }
    return CameraPermissionState.denied;
  }
}

/// Push outcome: [_Pushed] ran a real route (whose null/empty result is a
/// cancellation), [_NoNavigator] found no [Navigator] above the context.
sealed class _PushOutcome {
  const _PushOutcome();
}

final class _Pushed extends _PushOutcome {
  const _Pushed(this.text);
  final String? text;
}

final class _NoNavigator extends _PushOutcome {
  const _NoNavigator();
}

/// Camera-backed scanner: permission flow with graceful denial, then a
/// full-screen [QrScanScreen] whose captured text reuses the existing
/// first-join registration and error states in [JoinScreen].
final class CameraJoinPayloadScanner implements JoinPayloadScanner {
  CameraJoinPayloadScanner({
    BuildContext Function()? contextOf,
    CameraPermissionClient permissions =
        const PermissionHandlerCameraPermissions(),
  }) : _contextOf = contextOf,
       _permissions = permissions;

  /// Legacy ancestor-context supplier, kept for source compatibility.
  /// The invocation context always wins; this is only a last-resort
  /// fallback when it carries no [Navigator].
  final BuildContext Function()? _contextOf;
  final CameraPermissionClient _permissions;

  @override
  Future<JoinPayloadScanResult> scan([BuildContext? context]) async {
    final CameraPermissionState state = await _resolvePermission();
    switch (state) {
      case CameraPermissionState.granted:
        break;
      case CameraPermissionState.denied:
        return const JoinPayloadPermissionDenied();
      case CameraPermissionState.permanentlyDenied:
        return const JoinPayloadPermissionDenied(permanently: true);
    }
    // Prefer the invocation (descendant-of-MaterialApp) context: the
    // permission prompt may have backgrounded or closed the join screen,
    // so never push onto a dead element.
    final BuildContext? invocation = context;
    if (invocation != null) {
      if (!invocation.mounted) {
        return const JoinPayloadUnavailable();
      }
      final _PushOutcome first = await _pushScanner(invocation);
      switch (first) {
        case _Pushed(:final String? text):
          return _toResult(text);
        case _NoNavigator():
          // The invocation context carried no Navigator (a stale ancestor
          // context): try the legacy supplier once before giving up to
          // the type-or-paste path.
          break;
      }
    }
    final BuildContext? fallback = _legacyContext();
    if (fallback == null || !fallback.mounted) {
      return const JoinPayloadUnavailable();
    }
    final _PushOutcome second = await _pushScanner(fallback);
    if (second is! _Pushed || second.text == null) {
      return const JoinPayloadUnavailable();
    }
    return _toResult(second.text!);
  }

  JoinPayloadScanResult _toResult(String? text) {
    if (text == null || text.trim().isEmpty) {
      return const JoinPayloadUnavailable();
    }
    return JoinPayloadText(text);
  }

  /// Returns the legacy ancestor context when it can still host a route.
  BuildContext? _legacyContext() {
    final BuildContext Function()? supplier = _contextOf;
    if (supplier == null) {
      return null;
    }
    try {
      final BuildContext candidate = supplier();
      return candidate.mounted ? candidate : null;
    } on Exception {
      return null;
    }
  }

  Future<CameraPermissionState> _resolvePermission() async {
    try {
      CameraPermissionState state = await _permissions.check();
      if (state == CameraPermissionState.denied) {
        state = await _permissions.request();
      }
      return state;
    } on Exception {
      // The permission plugin itself failed (no platform channel in some
      // test harnesses, unexpected native error): stay on the retryable
      // denial path so type-or-paste keeps working.
      return CameraPermissionState.denied;
    }
  }

  Future<_PushOutcome> _pushScanner(BuildContext context) async {
    try {
      final String? text = await Navigator.of(
        context,
      ).push<String>(MaterialPageRoute(builder: (_) => const QrScanScreen()));
      return _Pushed(text);
    } on Exception {
      // No Navigator above this context: the caller falls back to the
      // legacy supplier or to the type-or-paste path.
      return const _NoNavigator();
    }
  }
}
