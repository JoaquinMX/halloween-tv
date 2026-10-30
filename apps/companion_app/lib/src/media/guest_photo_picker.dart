import 'dart:io';

import 'package:image_picker/image_picker.dart';

abstract interface class GuestPhotoPicker {
  Future<File?> pickPhoto();
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
}
