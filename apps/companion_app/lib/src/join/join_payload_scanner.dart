/// Scanner seam. A platform camera implementation is intentionally deferred.
abstract interface class JoinPayloadScanner {
  Future<JoinPayloadScanResult> scan();
}

sealed class JoinPayloadScanResult {
  const JoinPayloadScanResult();
}

final class JoinPayloadText extends JoinPayloadScanResult {
  const JoinPayloadText(this.text);
  final String text;
}

final class JoinPayloadUnavailable extends JoinPayloadScanResult {
  const JoinPayloadUnavailable();
}

final class UnavailableJoinPayloadScanner implements JoinPayloadScanner {
  const UnavailableJoinPayloadScanner();
  @override
  Future<JoinPayloadScanResult> scan() async => const JoinPayloadUnavailable();
}
