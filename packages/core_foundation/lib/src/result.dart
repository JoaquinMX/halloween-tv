/// Sealed result type for fallible domain operations.
sealed class Result<T> {
  const Result();

  /// True when this is an [Ok].
  bool get isOk => this is Ok<T>;

  /// True when this is an [Err].
  bool get isErr => this is Err<T>;

  /// Maps the success value, propagating errors untouched.
  Result<U> map<U>(U Function(T value) f) {
    final self = this;
    if (self is Ok<T>) {
      return Ok<U>(f(self.value));
    }
    return Err<U>((self as Err<T>).message);
  }
}

/// Success case of [Result].
final class Ok<T> extends Result<T> {
  /// The success value.
  final T value;
  const Ok(this.value);
}

/// Failure case of [Result].
final class Err<T> extends Result<T> {
  /// Human-readable failure reason.
  final String message;
  const Err(this.message);
}
