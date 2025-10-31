/// Shared runtime constants for the Halloween TV monorepo.
class CoreConstants {
  const CoreConstants._();

  /// Number of tiles expected in the CCTV wall.
  static const int requiredClipCount = 4;

  /// Default HTTP timeout used for external calls.
  static const Duration defaultHttpTimeout = Duration(seconds: 20);

  /// Default retry backoff durations.
  static const List<Duration> defaultRetryBackoff = <Duration>[
    Duration(milliseconds: 500),
    Duration(seconds: 1),
    Duration(seconds: 2),
  ];
}
