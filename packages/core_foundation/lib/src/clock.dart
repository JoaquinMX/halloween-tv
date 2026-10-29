/// Clock abstraction so domain code stays testable.
abstract class Clock {
  /// Current time.
  DateTime now();
}

/// System clock implementation.
final class SystemClock implements Clock {
  const SystemClock();

  @override
  DateTime now() => DateTime.now();
}
