import 'package:meta/meta.dart';

/// Base class for recoverable domain failures.
@immutable
abstract class Failure {
  const Failure(this.message, {this.cause, this.stackTrace});

  final String message;
  final Object? cause;
  final StackTrace? stackTrace;

  @override
  String toString() => '$runtimeType(message: $message, cause: $cause)';
}

/// A failure that indicates invalid data received from an upstream source.
class ValidationFailure extends Failure {
  const ValidationFailure(String message, {Object? cause, StackTrace? stackTrace})
      : super(message, cause: cause, stackTrace: stackTrace);
}

/// A failure representing network connectivity or HTTP errors.
class NetworkFailure extends Failure {
  const NetworkFailure(String message, {Object? cause, StackTrace? stackTrace})
      : super(message, cause: cause, stackTrace: stackTrace);
}

/// A failure representing cache related errors.
class CacheFailure extends Failure {
  const CacheFailure(String message, {Object? cause, StackTrace? stackTrace})
      : super(message, cause: cause, stackTrace: stackTrace);
}

/// A failure representing application settings errors.
class SettingsFailure extends Failure {
  const SettingsFailure(String message, {Object? cause, StackTrace? stackTrace})
      : super(message, cause: cause, stackTrace: stackTrace);
}
