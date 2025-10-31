import 'file_ref.dart';

/// Port describing the caching interface available to channels.
abstract class CachePort {
  Future<FileRef?> get(String localKey);
  Future<FileRef> put(String localKey, Stream<List<int>> bytes, {required String checksum});
}
