/// Firestore-backed current-manifest stream.
library;

import 'package:channel_api/channel_api.dart' show ManifestSource;
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:core_playlist/core_playlist.dart';

import 'package:infra_firestore/src/manifest_source.dart';

/// Emits current document data for a fully qualified Firestore path.
/// Injectable fake streams exercise the exact mapping and validation path
/// without initializing a Firebase app in unit tests.
typedef FirebaseManifestDocumentStream = Stream<Map<String, Object?>?> Function(
  String documentPath,
);

/// Signals that a current manifest could not be read from Firestore.
///
/// `PreparePlayback` maps stream errors to `errorRecoverable` and retains its
/// last committed manifest and media.
final class ManifestTransportException implements Exception {
  const ManifestTransportException(this.message, [this.cause]);

  final String message;
  final Object? cause;

  @override
  String toString() => cause == null
      ? 'ManifestTransportException: $message'
      : 'ManifestTransportException: $message ($cause)';
}

/// Signals a manifest document that is valid JSON but belongs to another
/// party or channel than the exact document subscription requested.
final class ManifestScopeException implements Exception {
  const ManifestScopeException(this.message);

  final String message;

  @override
  String toString() => 'ManifestScopeException: $message';
}

/// Watches only `parties/{partyId}/manifests/current_{channelId}`.
///
/// The Firebase SDK is resolved lazily when [watchCurrent] is subscribed, so
/// constructing offline-first stub dependencies does not initialize Firebase.
final class FirebaseManifestSource implements ManifestSource<PlaybackManifest> {
  FirebaseManifestSource({
    FirebaseFirestore? firestore,
    FirebaseManifestDocumentStream? watchDocumentData,
    DateTime Function()? now,
    this.maxTransportResubscriptions = 3,
    this.transportRetryDelay = const Duration(milliseconds: 250),
  }) : _firestore = firestore,
       _watchDocumentData = watchDocumentData,
       _now = now ?? DateTime.now;

  final FirebaseFirestore? _firestore;
  final FirebaseManifestDocumentStream? _watchDocumentData;
  final DateTime Function() _now;

  /// Number of times a failed document stream is reopened before surfacing.
  final int maxTransportResubscriptions;

  /// Delay between bounded transport resubscriptions.
  final Duration transportRetryDelay;

  @override
  Stream<PlaybackManifest> watchCurrent({
    required String partyId,
    required String channelId,
  }) async* {
    _validatePathId(partyId, 'partyId');
    _validatePathId(channelId, 'channelId');
    final String documentPath = 'parties/$partyId/manifests/current_$channelId';

    if (maxTransportResubscriptions < 0 || transportRetryDelay.isNegative) {
      throw ArgumentError('transport retry settings must be non-negative');
    }
    var failures = 0;
    while (true) {
      try {
        final Stream<Map<String, Object?>?> documents = _documentsFor(
          partyId,
          channelId,
          documentPath,
        );
        await for (final Map<String, Object?>? raw in documents) {
          if (raw == null) {
            throw const ManifestTransportException(
              'current manifest document does not exist',
            );
          }
          final Map<String, Object?> normalized = _normalizeMap(raw);
          final PlaybackManifest manifest = manifestFromFirestore(
            normalized,
            now: _now,
          );
          if (manifest.partyId != partyId || manifest.channelId != channelId) {
            throw ManifestScopeException(
              'requested $partyId/$channelId but document contains '
              '${manifest.partyId}/${manifest.channelId}',
            );
          }
          failures = 0;
          yield manifest;
        }
        return;
      } on ManifestSchemaException {
        rethrow;
      } on ManifestScopeException {
        rethrow;
      } on ManifestTransportException catch (error, stackTrace) {
        if (failures >= maxTransportResubscriptions) {
          Error.throwWithStackTrace(error, stackTrace);
        }
        failures++;
        await Future<void>.delayed(transportRetryDelay * failures);
      } on FirebaseException catch (error, stackTrace) {
        if (failures >= maxTransportResubscriptions) {
          Error.throwWithStackTrace(
            ManifestTransportException(
              'Firestore manifest stream failed',
              error,
            ),
            stackTrace,
          );
        }
        failures++;
        await Future<void>.delayed(transportRetryDelay * failures);
      } on Object catch (error, stackTrace) {
        if (failures >= maxTransportResubscriptions) {
          Error.throwWithStackTrace(
            ManifestTransportException('manifest stream failed', error),
            stackTrace,
          );
        }
        failures++;
        await Future<void>.delayed(transportRetryDelay * failures);
      }
    }
  }

  Stream<Map<String, Object?>?> _documentsFor(
    String partyId,
    String channelId,
    String documentPath,
  ) {
    final FirebaseManifestDocumentStream? fakeStream = _watchDocumentData;
    if (fakeStream != null) {
      return fakeStream(documentPath);
    }
    final DocumentReference<Map<String, dynamic>> current =
        (_firestore ?? FirebaseFirestore.instance)
            .collection('parties')
            .doc(partyId)
            .collection('manifests')
            .doc('current_$channelId');
    return current.snapshots().map(
      (DocumentSnapshot<Map<String, dynamic>> snapshot) => snapshot.data(),
    );
  }

  Map<String, Object?> _normalizeMap(Map<String, dynamic> raw) =>
      <String, Object?>{
        for (final MapEntry<String, dynamic> entry in raw.entries)
          entry.key: _normalizeValue(entry.value),
      };

  Object? _normalizeValue(Object? value) {
    if (value is Timestamp) {
      return value.toDate().toUtc();
    }
    if (value is DateTime) {
      return value.toUtc();
    }
    if (value is Map) {
      return <String, Object?>{
        for (final MapEntry<Object?, Object?> entry in value.entries)
          if (entry.key is String)
            entry.key! as String: _normalizeValue(entry.value),
      };
    }
    if (value is Iterable) {
      return value.map(_normalizeValue).toList(growable: false);
    }
    return value;
  }

  void _validatePathId(String value, String field) {
    if (value.trim().isEmpty || value.contains('/')) {
      throw ArgumentError.value(value, field, 'must be a single path segment');
    }
  }
}
