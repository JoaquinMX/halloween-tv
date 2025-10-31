import 'package:meta/meta.dart';

import 'failure.dart';

/// A lightweight Either-style result type.
@immutable
sealed class Result<T> {
  const Result();

  R when<R>({required R Function(T value) success, required R Function(Failure failure) failure}) {
    final Result<T> self = this;
    if (self is Success<T>) {
      return success(self.value);
    }
    if (self is FailureResult<T>) {
      return failure(self.failure);
    }
    throw StateError('Unknown Result subtype: $self');
  }

  bool get isSuccess => this is Success<T>;
  bool get isFailure => this is FailureResult<T>;

  T? get valueOrNull => this is Success<T> ? (this as Success<T>).value : null;
  Failure? get failureOrNull => this is FailureResult<T> ? (this as FailureResult<T>).failure : null;
}

class Success<T> extends Result<T> {
  const Success(this.value);
  final T value;
}

class FailureResult<T> extends Result<T> {
  const FailureResult(this.failure);
  final Failure failure;
}
