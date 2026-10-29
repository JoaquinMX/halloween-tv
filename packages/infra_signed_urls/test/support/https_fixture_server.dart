import 'dart:async';
import 'dart:convert';
import 'dart:io';

final class HttpsFixtureResponse {
  const HttpsFixtureResponse({
    required this.statusCode,
    this.body = const <int>[],
    this.declaredLength,
    this.delay = Duration.zero,
  });

  final int statusCode;
  final List<int> body;
  final int? declaredLength;
  final Duration delay;
}

/// Loopback HTTPS server used only by package tests. The test-only localhost
/// certificate is intentionally self-signed and trusted only by test clients.
final class HttpsFixtureServer {
  HttpsFixtureServer._(
    this._server,
    this.responses,
    this.onRequest,
    this.onResponse,
  );

  static const String _certificate = '''
-----BEGIN CERTIFICATE-----
MIIDHzCCAgegAwIBAgIUU2t7QLPaQsiJZioqRi2DzmWCHBUwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAyOTIwMTMxOVoXDTM2MTAy
NjIwMTMxOVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEFAA
OCAQ8AMIIBCgKCAQEAs7SvqHpP0uBpYsWbQ5F6IrwM3LzlRaYKDWEf4JeEOayF
BKw+UlRVlwGlAGrh2/cUk78Ur75Q8y6CGn6dsbMOU7I+/QZg8GSCzFzvJP/ld6T0
VDOAmnKec8IMm7xSWOV6aEeyicTLBLHDyq2q6r8C683twQTkGmXREbSvpWs4ks5C
rKKrFCxJ6BP0HG/xFGKx6rxHvMI6Dm5PEuE8w80bjARIEZD+eyPZ+norZS6PM4ob
MfeEhtv/kEbM/LTnoSnGrbFCH2yXUHPjtu0lbmiMmKcVW8V98GzsSPB6Q+RZfJxT
7Bgg90aKJQ7AkgoJ/o6L1zuCeRqGw6u8UL+40QFHUwIDAQABo2kwZzAdBgNVHQ4E
FgQUAZIMXIazxIeWVShokNCVxTbLspAwHwYDVR0jBBgwFoAUAZIMXIazxIeWVSho
kNCVxTbLspAwDwYDVR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3Qw
DQYJKoZIhvcNAQELBQADggEBAA1IyQi8ixd90zr14WrBPkqRk/u9lPfZ8SqDGhWh
MoBmzXKq1Bfo/nn0o3bUIGRB1BJIit8J8PY5Qj0K0Ds6/UAMO9TAq7+/ujDfO05V
Ej9E8c1ktNK5qd0NsKOi14lerVTT89hyCjeWjcY6Q5ZDZTJSAgTc7/tfOnmBalJh
IeaGTx6pSbRWy6SY7ri7SFOJd9gYj7pNdlfWzzHmbazdArP1vmSpllWxaLPFFukH
FRSswmtpVbtGIVXaDz9XaTVLLPlwH9d/ffKpcOBPRz9UwkfRFBCrlTOBhSdEmkHF
aEHmI4gkDxGZ+nILzlWqjk/cvLYlqo4W6cM9KGVAVYIamTs=
-----END CERTIFICATE-----
''';

  static const String _privateKey = '''
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCztK+oek/S4Gli
xZtDkXoivAzcvOVFpgoNYR/gl4Q5rIUErD5SVFWXAaUAauHb9xSTvxSvvlDzLoIa
fp2xsw5Tsj79BmDwZILMXO8k/+V3pPRUM4Cacp5zwgybvFJY5XpoR7KJxMsEscPK
rarqvwLrze3BBOQaZdERtK+laziSzkKsoqsULEnoE/Qcb/EUYrHqvEe8wjoObk8S
4TzDzRuMBEgRkP57I9n6eitlLo8zihsx94SG2/+QRsz8tOehKcatsUIfbJdQc+O2
7SVuaIyYpxVbxX3wbOxI8HpD5Fl8nFPsGCD3RoolDsCSCgn+jovXO4J5GobDq7xQ
v7jRAUdTAgMBAAECggEAO2gS3a45byvSit1qW2bfKlZiJiKn5GNkVVHzOMq94lb+
zjGmlI7ekIHxqvaqXY4LlmAHlaVjm1CXn+yVcuYPaWm2Wuzd5PpFJwvd3qxdjjTQ
tHkmHWigqwHOKzmRO2P5GDoDcnnE53Ngl0LcCqhEbfFwlGtqgLOB7sl9e0C7vgO0
alOi50CaDWlk5wGyU6Ru2Q/t6qmCbvHNXdBapZQo6t3LVqChR91NRoSMN9QfdjVg
RjsrJKd1rVfCUkO6Zeb3hd5NTqyKy6U6i2KJi8zAvCPJ/UkA0kU2tby8vL8gcPHU
G4bwRMEwrPIa/qIwmtC45GDBiLAWlw/dekGjx57KmQKBgQD2QrXoEhhTHbw4laGX
Y12wqMVOYQgEMVOq8MvKDBJ4gcN7NGTBTVp5XZFtuOwgJXfWmlzrRdb0JdIhHybY
MsTKEc9XOWqzG5f+AgoFNnkgaoO7KWn82ijofcMSQKwFKCvomupdjzM0T80m3dFI
wJ89qjIjqVgUmVZtELFYUYS3ZQKBgQC60CKbGxZM0BeK7umPMRBRsnhl7mXjYW6U
lmIPPLM44dU+9QS58/x7MJ1qR+ZShsndIiULtW08nAIUtg1unafEdbfKWEjXvPJq
uigEAk8y+pPRezd/rXdwhxw4RN97APQunNN9PrmS2cvaC/qoTDR7Pfk38UlumFZp
9yXzNL3kVwKBgDjUZE5N/rcPoaQdQ9E/6Rsfl4ji84qkJ37HWwAhkRGmQIpqKOZD
B6ICadE8X6F7hBBORys0TsrA/6ENI1W5QZiwS30BjxIOSCEiL1XMoF9OtV+3yvHD
FrWwcBgCPLBj+N4RAgzdQx/LWrihb+6uJRGB+VgpeF4olL1OoN6U0V/RAoGBAIM8
pJMCPHBJ38AihsGpXiWGkz5IdBuA3wZTfx/lLKLRQ9Wum1tnJAAG7w8y44MmXbmT
uyK2mb7yeiPCoT0MVEeXyz3DN6kXe9WuYV4voSPXFPEc9qgjXL0YraJ5/+WRjfkR
AyIBZqzbhHHx6G1C27uYlfPO9h9TtaFLlsV8T8qRAoGACN9n975xJ0/IABfG+Yxd
egPKja+XfXOhnEBpADZc2+qKcYgp30Ry2LoNxnAzop0O3Id4NPfTK58fHgJBk//L
Eb6iqIvcnjPDjsIX2sNssiX7veTlR2r2WmwrsEhX2AIbcPOflE0gTVqeyLQZN2iH
Cm2+6PVkwNiB/1KHzCuQrVU=
-----END PRIVATE KEY-----
''';

  final HttpServer _server;
  final Map<String, HttpsFixtureResponse> responses;
  final void Function(String path)? onRequest;
  final void Function(String path)? onResponse;

  Uri uriFor(String path) =>
      Uri(scheme: 'https', host: '127.0.0.1', port: _server.port, path: path);

  static Future<HttpsFixtureServer> start({
    required Map<String, HttpsFixtureResponse> responses,
    void Function(String path)? onRequest,
    void Function(String path)? onResponse,
  }) async {
    final SecurityContext context = SecurityContext()
      ..useCertificateChainBytes(utf8.encode(_certificate))
      ..usePrivateKeyBytes(utf8.encode(_privateKey));
    final HttpServer server = await HttpServer.bindSecure(
      InternetAddress.loopbackIPv4,
      0,
      context,
    );
    final fixture = HttpsFixtureServer._(
      server,
      responses,
      onRequest,
      onResponse,
    );
    unawaited(fixture._serve());
    return fixture;
  }

  Future<void> _serve() async {
    await for (final HttpRequest request in _server) {
      unawaited(_respond(request));
    }
  }

  Future<void> _respond(HttpRequest request) async {
    final String path = request.uri.path;
    onRequest?.call(path);
    final HttpsFixtureResponse? fixture = responses[path];
    if (fixture == null) {
      request.response.statusCode = HttpStatus.notFound;
      await request.response.close();
      onResponse?.call(path);
      return;
    }
    if (fixture.delay > Duration.zero) {
      await Future<void>.delayed(fixture.delay);
    }
    request.response.statusCode = fixture.statusCode;
    if (fixture.declaredLength != null) {
      request.response.contentLength = fixture.declaredLength!;
    }
    try {
      request.response.add(fixture.body);
      await request.response.close();
    } on Object {
      // A declared length larger than the body truncates the connection:
      // detach the socket so the client observes a partial failure instead
      // of the server-side length check surfacing as a test-harness error.
      try {
        final Socket socket = await request.response.detachSocket();
        socket.destroy();
      } on Object {
        // The connection is already unusable; the client sees the truncation.
      }
    }
    onResponse?.call(path);
  }

  Future<void> close() => _server.close(force: true);
}

HttpClient testHttpClient() => HttpClient()
  ..badCertificateCallback =
      (X509Certificate certificate, String host, int port) =>
          host == '127.0.0.1' && certificate.subject.contains('localhost');
