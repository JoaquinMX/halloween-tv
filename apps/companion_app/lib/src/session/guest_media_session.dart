import 'dart:io';

import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:companion_app/src/data/guest_media_client.dart';

/// Consent-gated upload workflow. No capability call exists before submit().
///
/// Each submit mints a new server-side submission with its own persisted
/// receipt, so outstanding submissions each keep their withdrawal path:
/// withdrawing one submission never strands the others. Receipts are scoped
/// per device via SharedPreferences ([receiptsKey]); the legacy single-slot
/// [receiptKey] is kept in sync with the latest id for backward
/// compatibility with installs that predate multi-receipt support.
final class GuestMediaSession {
  GuestMediaSession({
    required this.client,
    required this.partyId,
    required this.deviceId,
    required this.channelId,
    Future<SharedPreferences> Function()? preferences,
    Future<Directory> Function()? tempDirectory,
  }) : _preferences = preferences ?? SharedPreferences.getInstance,
       _tempDirectory = tempDirectory ?? getTemporaryDirectory;
  final GuestMediaClient client;
  final String partyId, deviceId, channelId;
  final Future<SharedPreferences> Function() _preferences;
  final Future<Directory> Function() _tempDirectory;
  static const receiptKey = 'companion.guest_media_receipt.v1';
  static const receiptsKey = 'companion.guest_media_receipts.v1';

  /// Outstanding (not yet withdrawn/expired) submission ids, oldest first.
  final List<String> submissionIds = <String>[];

  /// Last known status per submission id (backend GuestMediaStatus values:
  /// pending_upload | eligible | withdrawn | expired).
  final Map<String, String> statuses = <String, String>{};

  /// Latest outstanding submission, or null when none is outstanding.
  String? get submissionId =>
      submissionIds.isEmpty ? null : submissionIds.last;

  /// Last known status of the latest outstanding submission.
  String? get status =>
      submissionId == null ? _terminalStatus : statuses[submissionId];

  String? _terminalStatus;
  bool busy = false;

  Future<void> submit(
    File photo, {
    required bool consent,
    required bool confirmed,
    String contentType = 'image/jpeg',
  }) async {
    if (!consent || !confirmed) {
      throw StateError(
        'Affirmative consent and upload confirmation are required',
      );
    }
    if (busy) return;
    busy = true;
    File? staged;
    try {
      final String extension =
          contentType == 'image/png' ? '.png' : '.jpg';
      final directory = await _tempDirectory();
      staged = File(
        '${directory.path}/guest-upload-${DateTime.now().microsecondsSinceEpoch}$extension',
      );
      await photo.copy(staged.path);
      final capability = await client.requestUpload(
        partyId: partyId,
        deviceId: deviceId,
        channelId: channelId,
        contentType: contentType,
        byteSize: await staged.length(),
        affirmativeConsent: consent,
      );
      submissionIds.add(capability.submissionId);
      await _persistReceipts();
      await client.upload(capability, staged);
      await client.complete(
        partyId: partyId,
        deviceId: deviceId,
        channelId: channelId,
        submissionId: capability.submissionId,
      );
      statuses[capability.submissionId] = 'complete';
      _terminalStatus = null;
    } catch (_) {
      if (submissionId != null) {
        statuses.putIfAbsent(submissionId!, () => 'recovery-required');
      } else {
        _terminalStatus ??= 'recovery-required';
      }
      rethrow;
    } finally {
      if (staged != null && await staged.exists()) await staged.delete();
      busy = false;
    }
  }

  Future<void> recover() async {
    final prefs = await _preferences();
    final List<String> stored =
        prefs.getStringList(receiptsKey) ?? _legacyReceipt(prefs);
    submissionIds
      ..clear()
      ..addAll(stored);
    _terminalStatus = null;
    for (final String id in List<String>.of(submissionIds)) {
      final result = await client.status(
        partyId: partyId,
        deviceId: deviceId,
        channelId: channelId,
        submissionId: id,
      );
      final String known = result['status'] is String
          ? result['status'] as String
          : 'unknown';
      if (known == 'withdrawn' || known == 'expired') {
        submissionIds.remove(id);
        statuses.remove(id);
        _terminalStatus = known;
      } else {
        statuses[id] = known;
      }
    }
    await _persistReceipts();
  }

  /// Withdraws [submissionId] (defaults to the latest outstanding one) and,
  /// on the backend terminal status `withdrawn`, drops its receipt so it is
  /// never retried. Other outstanding submissions are untouched.
  Future<void> withdraw({String? submissionId}) async {
    final id = submissionId ?? this.submissionId;
    if (id == null || busy) return;
    busy = true;
    try {
      final result = await client.withdraw(
        partyId: partyId,
        deviceId: deviceId,
        channelId: channelId,
        submissionId: id,
      );
      final String returned = result['status'] is String
          ? result['status'] as String
          : 'unknown';
      if (returned == 'withdrawn') {
        submissionIds.remove(id);
        statuses.remove(id);
        _terminalStatus = 'withdrawn';
        await _persistReceipts();
      } else {
        statuses[id] = returned;
      }
    } finally {
      busy = false;
    }
  }

  Future<void> retryWithdrawal({String? submissionId}) =>
      withdraw(submissionId: submissionId);

  static List<String> _legacyReceipt(SharedPreferences prefs) {
    final String? legacy = prefs.getString(receiptKey);
    return legacy == null || legacy.isEmpty ? <String>[] : <String>[legacy];
  }

  Future<void> _persistReceipts() async {
    final prefs = await _preferences();
    if (!await prefs.setStringList(
      receiptsKey,
      List<String>.unmodifiable(submissionIds),
    )) {
      throw StateError('Could not save submission receipts');
    }
    // Legacy single-slot key mirrors the latest id (or is cleared when no
    // submission is outstanding) for pre-multi-receipt installs.
    if (submissionIds.isEmpty) {
      await prefs.remove(receiptKey);
    } else {
      if (!await prefs.setString(receiptKey, submissionIds.last)) {
        throw StateError('Could not save submission receipt');
      }
    }
  }
}
