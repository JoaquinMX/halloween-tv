import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_signed_urls/infra_signed_urls.dart';

ClipDescriptor clip({
  String id = 'clip-1',
  String storageObjectId = 'cctv/cam-01.mp4',
  String mimeType = 'video/mp4',
}) => ClipDescriptor(
  id: id,
  cameraId: 'CAM-01',
  storageObjectId: storageObjectId,
  sha256: 'a' * 64,
  sizeBytes: 1024,
  duration: const Duration(seconds: 8),
  mimeType: mimeType,
);

void main() {
  group('localMediaUriFor', () {
    test('derives a stable local URI from the storage object id', () {
      final uri = localMediaUriFor(clip());

      expect(uri.scheme, kLocalMediaScheme);
      expect(uri.host, 'media');
      expect(uri.pathSegments, ['cctv', 'cam-01.mp4']);
      expect(uri.toString(), 'local://media/cctv/cam-01.mp4');
    });

    test('percent-encodes storage object ids with reserved characters', () {
      final uri = localMediaUriFor(clip(storageObjectId: 'cctv/cam 01.mp4'));

      expect(uri.pathSegments.last, 'cam 01.mp4');
      expect(uri.toString(), contains('%20'));
    });

    test('rejects a blank storage object id', () {
      expect(
        () => localMediaUriFor(clip(storageObjectId: '   ')),
        throwsArgumentError,
      );
    });
  });

  group('PassthroughUrlSigner', () {
    test('returns the clip local URI unchanged', () async {
      const UrlSigner signer = PassthroughUrlSigner();
      final target = clip();

      final signed = await signer.signFor(target);

      expect(signed, localMediaUriFor(target));
      expect(signed.toString(), 'local://media/cctv/cam-01.mp4');
    });

    test('returns equal URIs across calls and expiries', () async {
      const UrlSigner signer = PassthroughUrlSigner();
      final target = clip(storageObjectId: 'cctv/cam-02.mp4');

      final first = await signer.signFor(target);
      final second = await signer.signFor(
        target,
        expiry: const Duration(minutes: 5),
      );
      final third = await signer.signFor(
        target,
        expiry: const Duration(seconds: 30),
      );

      expect(first, second);
      expect(second, third);
      expect(first, localMediaUriFor(target));
    });

    test('derives the URI from the object id, not the clip id', () async {
      const UrlSigner signer = PassthroughUrlSigner();

      final a = await signer.signFor(clip(id: 'clip-1'));
      final b = await signer.signFor(
        clip(id: 'clip-2', mimeType: 'video/quicktime'),
      );

      expect(a, b);
    });

    test('distinct storage objects map to distinct URIs', () async {
      const UrlSigner signer = PassthroughUrlSigner();

      final a = await signer.signFor(clip(storageObjectId: 'cctv/cam-01.mp4'));
      final b = await signer.signFor(clip(storageObjectId: 'cctv/cam-02.mp4'));

      expect(a, isNot(b));
    });

    test('rejects a negative expiry', () async {
      const UrlSigner signer = PassthroughUrlSigner();

      expect(
        () => signer.signFor(clip(), expiry: const Duration(seconds: -1)),
        throwsArgumentError,
      );
    });
  });
}
