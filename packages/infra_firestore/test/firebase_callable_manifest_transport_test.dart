import 'dart:async';

import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_firestore/infra_firestore.dart';

final class _CallableInvoker implements FirebaseManifestCallableInvoker {
  _CallableInvoker(this.responses);

  final Object? Function(int callNumber) responses;
  final List<(String, Map<String, Object?>)> calls =
      <(String, Map<String, Object?>)>[];

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    calls.add((name, Map<String, Object?>.of(payload)));
    return responses(calls.length);
  }
}

Map<String, Object?> _manifestDocument() => <String, Object?>{
  'schemaVersion': 1,
  'partyId': 'pilot',
  'channelId': 'main',
  'version': 1,
  'publishedAt': '2026-10-29T13:00:00.000Z',
  'overlay': <String, Object?>{
    'scanlineOpacity': 0.5,
    'noiseLevel': 0.2,
    'vignette': 0.6,
  },
  'clips': <Map<String, Object?>>[
    for (var index = 1; index <= 4; index++)
      <String, Object?>{
        'id': 'clip-$index',
        'cameraId': 'CAM-0$index',
        'storageObjectId': 'camera-$index.mp4',
        'sha256': String.fromCharCode(96 + index) * 64,
        'sizeBytes': 10,
        'durationMs': 2000,
        'mimeType': 'video/mp4',
      },
  ],
};

void main() {
  const String path = 'parties/pilot/manifests/current_main';

  test(
    'calls registered getCurrentManifest and preserves mapper scope checks',
    () async {
      final _CallableInvoker invoker = _CallableInvoker(
        (_) => _manifestDocument(),
      );
      final FirebaseCallableManifestTransport transport =
          FirebaseCallableManifestTransport(
            identity: FirebaseTvIdentity(partyId: 'pilot', deviceId: 'tv-1'),
            callableInvoker: invoker,
            pollInterval: const Duration(seconds: 1),
          );
      final FirebaseManifestSource source = FirebaseManifestSource(
        watchDocumentData: transport.watchDocumentData,
      );

      final PlaybackManifest manifest = await source
          .watchCurrent(partyId: 'pilot', channelId: 'main')
          .first;

      expect(manifest.version, 1);
      expect(manifest.clips, hasLength(4));
      expect(invoker.calls.single.$1, 'getCurrentManifest');
      expect(invoker.calls.single.$2, <String, Object?>{
        'partyId': 'pilot',
        'deviceId': 'tv-1',
        'channelId': 'main',
      });
    },
  );

  test(
    'cancellation stops later polling after the active call completes',
    () async {
      final _CallableInvoker invoker = _CallableInvoker(
        (_) => _manifestDocument(),
      );
      final FirebaseCallableManifestTransport transport =
          FirebaseCallableManifestTransport(
            identity: FirebaseTvIdentity(partyId: 'pilot', deviceId: 'tv-1'),
            callableInvoker: invoker,
            pollInterval: const Duration(milliseconds: 2),
          );
      final Completer<void> firstDocument = Completer<void>();
      final StreamSubscription<Map<String, Object?>?> subscription = transport
          .watchDocumentData(path)
          .listen((_) => firstDocument.complete());
      await firstDocument.future;
      await subscription.cancel();
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(invoker.calls, hasLength(1));
    },
  );

  test('recovers a failed poll with bounded retry and then cancels', () async {
    final _CallableInvoker invoker = _CallableInvoker((int callNumber) {
      if (callNumber == 1) throw StateError('temporary transport failure');
      return _manifestDocument();
    });
    final FirebaseCallableManifestTransport transport =
        FirebaseCallableManifestTransport(
          identity: FirebaseTvIdentity(partyId: 'pilot', deviceId: 'tv-1'),
          callableInvoker: invoker,
          pollInterval: const Duration(seconds: 1),
          initialRetryDelay: Duration.zero,
          maxRetryDelay: Duration.zero,
          maxConsecutiveFailures: 1,
        );

    final Map<String, Object?>? document = await transport
        .watchDocumentData(path)
        .first;

    expect(document?['version'], 1);
    expect(invoker.calls, hasLength(2));
  });

  test(
    'terminates after the configured consecutive callable failures',
    () async {
      final _CallableInvoker invoker = _CallableInvoker(
        (_) => throw StateError('offline'),
      );
      final FirebaseCallableManifestTransport transport =
          FirebaseCallableManifestTransport(
            identity: FirebaseTvIdentity(partyId: 'pilot', deviceId: 'tv-1'),
            callableInvoker: invoker,
            initialRetryDelay: Duration.zero,
            maxRetryDelay: Duration.zero,
            maxConsecutiveFailures: 1,
          );

      await expectLater(
        transport.watchDocumentData(path),
        emitsError(isA<ManifestTransportException>()),
      );
      expect(invoker.calls, hasLength(2));
    },
  );

  test('source resubscribes after a failed callable stream', () async {
    final _CallableInvoker invoker = _CallableInvoker((int callNumber) {
      if (callNumber == 1) throw StateError('first connection failed');
      return _manifestDocument();
    });
    final FirebaseCallableManifestTransport transport =
        FirebaseCallableManifestTransport(
          identity: FirebaseTvIdentity(partyId: 'pilot', deviceId: 'tv-1'),
          callableInvoker: invoker,
          maxConsecutiveFailures: 0,
          initialRetryDelay: Duration.zero,
          maxRetryDelay: Duration.zero,
        );
    final FirebaseManifestSource source = FirebaseManifestSource(
      watchDocumentData: transport.watchDocumentData,
      maxTransportResubscriptions: 1,
      transportRetryDelay: Duration.zero,
    );

    final PlaybackManifest manifest = await source
        .watchCurrent(partyId: 'pilot', channelId: 'main')
        .first;

    expect(manifest.version, 1);
    expect(invoker.calls, hasLength(2));
  });
}
