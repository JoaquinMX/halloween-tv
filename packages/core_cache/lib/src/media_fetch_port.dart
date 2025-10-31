import 'file_ref.dart';

/// Port responsible for prefetching signed media URLs to the cache.
abstract class MediaFetchPort {
  Future<bool> exists(String localKey, {String? checksum});
  Future<FileRef> prefetch(ClipRef ref, {required String checksum});
}

/// Lightweight description of a clip download.
class ClipRef {
  const ClipRef({required this.localKey, required this.signedUrl, required this.sizeBytes});

  final String localKey;
  final String signedUrl;
  final int sizeBytes;
}
