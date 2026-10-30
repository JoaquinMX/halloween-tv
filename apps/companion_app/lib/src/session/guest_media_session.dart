import 'dart:io';

import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:companion_app/src/data/guest_media_client.dart';

/// Consent-gated upload workflow. No capability call exists before submit().
final class GuestMediaSession {
  GuestMediaSession({
    required this.client,
    required this.partyId,
    required this.deviceId,
    Future<SharedPreferences> Function()? preferences,
    Future<Directory> Function()? tempDirectory,
  }) : _preferences = preferences ?? SharedPreferences.getInstance,
       _tempDirectory = tempDirectory ?? getTemporaryDirectory;
  final GuestMediaClient client;
  final String partyId, deviceId;
  final Future<SharedPreferences> Function() _preferences;
  final Future<Directory> Function() _tempDirectory;
  static const receiptKey = 'companion.guest_media_receipt.v1';
  String? submissionId;
  String? status;
  bool busy = false;
  Future<void> submit(
    File photo, {
    required bool consent,
    required bool confirmed,
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
      final directory = await _tempDirectory();
      staged = File(
        '${directory.path}/guest-upload-${DateTime.now().microsecondsSinceEpoch}.jpg',
      );
      await photo.copy(staged.path);
      final capability = await client.requestUpload(
        partyId: partyId,
        deviceId: deviceId,
        contentType: 'image/jpeg',
        byteSize: await staged.length(),
        affirmativeConsent: consent,
      );
      submissionId = capability.submissionId;
      final prefs = await _preferences();
      if (!await prefs.setString(receiptKey, submissionId!)) {
        throw StateError('Could not save submission receipt');
      }
      await client.upload(capability, staged);
      await client.complete(
        partyId: partyId,
        deviceId: deviceId,
        submissionId: submissionId!,
      );
      status = 'complete';
    } catch (_) {
      status ??= 'recovery-required';
      rethrow;
    } finally {
      if (staged != null && await staged.exists()) await staged.delete();
      busy = false;
    }
  }

  Future<void> recover() async {
    final prefs = await _preferences();
    submissionId = prefs.getString(receiptKey);
    if (submissionId == null) return;
    final result = await client.status(
      partyId: partyId,
      deviceId: deviceId,
      submissionId: submissionId!,
    );
    status = result['status'] is String
        ? result['status'] as String
        : 'unknown';
  }

  Future<void> withdraw() async {
    final id = submissionId;
    if (id == null || busy) return;
    busy = true;
    try {
      final result = await client.withdraw(
        partyId: partyId,
        deviceId: deviceId,
        submissionId: id,
      );
      status = switch (result['status']) {
        'withdrawalRecorded' || 'withdrawal_recorded' => 'recorded',
        'deletion_pending' => 'deletionPending',
        final String value => value,
        _ => 'unknown',
      };
      if (status == 'deleted') {
        await (await _preferences()).remove(receiptKey);
        submissionId = null;
      }
    } finally {
      busy = false;
    }
  }

  Future<void> retryWithdrawal() => withdraw();
}
