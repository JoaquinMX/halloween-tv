import 'dart:io';

import 'package:image_picker/image_picker.dart';

abstract interface class GuestPhotoPicker {
  Future<File?> pickPhoto();

  /// Backend-bound content type for [file], threaded into
  /// `GuestMediaSession.submit` (the client signs the PUT for exactly one
  /// of the backend-allowed types; never hardcode it at the call site).
  ///
  /// Pinned to backend/functions/src/config.ts -> GUEST_ALLOWED_CONTENT_TYPES
  /// (["image/jpeg", "image/png"]): `.png` maps to `image/png`, everything
  /// else to `image/jpeg` (the gallery picker only produces real photos).
  String contentTypeFor(File file);
}

final class NativeGuestPhotoPicker implements GuestPhotoPicker {
  NativeGuestPhotoPicker({ImagePicker? picker})
    : _picker = picker ?? ImagePicker();
  final ImagePicker _picker;
  @override
  Future<File?> pickPhoto() async {
    final XFile? photo = await _picker.pickImage(source: ImageSource.gallery);
    return photo == null ? null : File(photo.path);
  }

  @override
  String contentTypeFor(File file) =>
      file.path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
}
