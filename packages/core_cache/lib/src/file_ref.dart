import 'dart:io';

import 'package:meta/meta.dart';

/// Reference to a cached file on disk.
@immutable
class FileRef {
  const FileRef({required this.file, required this.checksum});

  final File file;
  final String checksum;
}
