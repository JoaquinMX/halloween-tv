/// Sanitized, user-presentable manifest failure states.
///
/// Raw backend payloads, digests, and SDK messages never reach the UI:
/// [ManifestFailure.classify] unwraps [ManifestTransportException] cause
/// chains and `FirebaseFunctionsException` codes (including the backend
/// `details.errorCode` contract codes from
/// `test/fixtures/backend_contract_v1.json`) into a fixed message per
/// [ManifestFailureKind]. Retry affordances read [retryable]: transport and
/// transient backend failures surface promptly and retry explicitly.
library;

import 'dart:async';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:infra_firestore/infra_firestore.dart'
    show
        ManifestSchemaException,
        ManifestScopeException,
        ManifestTransportException;

/// Sanitized manifest failure kinds.
enum ManifestFailureKind {
  /// Backend is not configured or the configuration is invalid.
  configuration,

  /// Caller identity was rejected (`UNAUTHENTICATED`).
  ///
  /// There is no login in this app: this means the device is not
  /// provisioned for the party.
  unauthenticated,

  /// Party/device pair is not an active registration (`FORBIDDEN`).
  forbidden,

  /// No manifest is published yet (`NOT_FOUND`).
  notFound,

  /// The request was rejected (`INVALID_ARGUMENT`).
  invalidArgument,

  /// The published lineup expired (`CLIP_EXPIRED`). Never labeled current.
  expired,

  /// Transient backend failure (`PROVIDER_UNAVAILABLE`, `BUDGET_EXCEEDED`).
  unavailable,

  /// Network/transport failure.
  transport,

  /// The callable exceeded its bounded timeout.
  timeout,

  /// Valid JSON that failed schema, scope, or camera validation.
  malformed,
}

/// Sanitized application state for a manifest read failure.
final class ManifestFailure {
  const ManifestFailure._(this.kind, this.message, this.retryable);

  /// Classifies [error] into a sanitized state.
  ///
  /// Unwraps [ManifestTransportException] cause chains, maps
  /// [FirebaseFunctionsException] `code` (preferring a `details`
  /// `errorCode` contract code when present), and maps schema/scope,
  /// timeout, and format errors. Unknown errors become
  /// [ManifestFailureKind.transport].
  factory ManifestFailure.classify(Object error) {
    Object current = error;
    final List<Object> seen = <Object>[];
    while (current is ManifestTransportException &&
        current.cause != null &&
        !seen.contains(current)) {
      seen.add(current);
      current = current.cause!;
    }
    if (current is ManifestFailure) {
      return current;
    }
    if (current is FirebaseFunctionsException) {
      return _fromCodes(current.code, _detailsErrorCode(current.details));
    }
    if (current is Map) {
      final String? code = _detailsErrorCode(current);
      if (code != null) {
        return _fromCodes('', code);
      }
    }
    if (current is ManifestSchemaException ||
        current is ManifestScopeException) {
      return const ManifestFailure._(
        ManifestFailureKind.malformed,
        'The manifest data was invalid.',
        false,
      );
    }
    if (current is TimeoutException) {
      return const ManifestFailure._(
        ManifestFailureKind.timeout,
        'The request timed out.',
        true,
      );
    }
    if (current is FormatException) {
      return const ManifestFailure._(
        ManifestFailureKind.malformed,
        'The manifest data was invalid.',
        false,
      );
    }
    if (current is ArgumentError) {
      return const ManifestFailure._(
        ManifestFailureKind.configuration,
        'The backend is not configured.',
        false,
      );
    }
    return const ManifestFailure._(
      ManifestFailureKind.transport,
      'Could not reach the backend.',
      true,
    );
  }

  /// Recoverable configuration state (unconfigured or init failure).
  factory ManifestFailure.configuration([String? reason]) => ManifestFailure._(
    ManifestFailureKind.configuration,
    reason == null || reason.isEmpty
        ? 'The backend is not configured.'
        : 'The backend is not configured: $reason',
    false,
  );

  final ManifestFailureKind kind;
  final String message;
  final bool retryable;

  @override
  String toString() => 'ManifestFailure($kind)';

  static ManifestFailure _fromCodes(String code, String? detailsCode) {
    final String? contract = detailsCode?.toUpperCase();
    switch (contract) {
      case 'UNAUTHENTICATED':
        return const ManifestFailure._(
          ManifestFailureKind.unauthenticated,
          'This device is not provisioned for this party.',
          false,
        );
      case 'FORBIDDEN':
        return const ManifestFailure._(
          ManifestFailureKind.forbidden,
          'Access was denied.',
          false,
        );
      case 'NOT_FOUND':
        return const ManifestFailure._(
          ManifestFailureKind.notFound,
          'No manifest is published yet.',
          false,
        );
      case 'INVALID_ARGUMENT':
        return const ManifestFailure._(
          ManifestFailureKind.invalidArgument,
          'The request was rejected.',
          false,
        );
      case 'PROVIDER_UNAVAILABLE':
      case 'BUDGET_EXCEEDED':
        return const ManifestFailure._(
          ManifestFailureKind.unavailable,
          'The service is temporarily unavailable.',
          true,
        );
      case 'MANIFEST_MISMATCH':
        return const ManifestFailure._(
          ManifestFailureKind.malformed,
          'The manifest data was invalid.',
          false,
        );
      case 'CLIP_EXPIRED':
        return const ManifestFailure._(
          ManifestFailureKind.expired,
          'This lineup has expired.',
          false,
        );
      case 'INTERNAL':
        return const ManifestFailure._(
          ManifestFailureKind.transport,
          'Could not reach the backend.',
          true,
        );
    }
    switch (code.trim().toLowerCase().replaceAll('_', '-')) {
      case 'unauthenticated':
        return const ManifestFailure._(
          ManifestFailureKind.unauthenticated,
          'This device is not provisioned for this party.',
          false,
        );
      case 'permission-denied':
        return const ManifestFailure._(
          ManifestFailureKind.forbidden,
          'Access was denied.',
          false,
        );
      case 'not-found':
        return const ManifestFailure._(
          ManifestFailureKind.notFound,
          'No manifest is published yet.',
          false,
        );
      case 'invalid-argument':
        return const ManifestFailure._(
          ManifestFailureKind.invalidArgument,
          'The request was rejected.',
          false,
        );
      case 'unavailable':
      case 'resource-exhausted':
      case 'aborted':
        return const ManifestFailure._(
          ManifestFailureKind.unavailable,
          'The service is temporarily unavailable.',
          true,
        );
      case 'deadline-exceeded':
        return const ManifestFailure._(
          ManifestFailureKind.timeout,
          'The request timed out.',
          true,
        );
    }
    return const ManifestFailure._(
      ManifestFailureKind.transport,
      'Could not reach the backend.',
      true,
    );
  }

  static String? _detailsErrorCode(Object? details) {
    if (details is Map) {
      for (final MapEntry<Object?, Object?> entry in details.entries) {
        if (entry.key == 'errorCode' && entry.value is String) {
          return entry.value! as String;
        }
      }
    }
    return null;
  }
}
