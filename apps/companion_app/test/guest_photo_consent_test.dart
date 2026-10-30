import 'dart:io';

import 'package:companion_app/src/data/guest_media_client.dart';
import 'package:companion_app/src/media/guest_photo_picker.dart';
import 'package:companion_app/src/session/guest_media_session.dart';
import 'package:companion_app/src/ui/guest_photo_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class Picker implements GuestPhotoPicker {
  Picker(this.file);
  final File file;
  @override
  Future<File?> pickPhoto() async => file;
}

class Boundary implements GuestMediaCallableInvoker {
  int requests = 0;
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    if (name == kRequestGuestUpload) {
      requests++;
      return {
        'submissionId': 'receipt_12345',
        'uploadUrl': 'https://signed.example/upload',
        'contentType': 'image/jpeg',
      };
    }
    return {'status': 'complete'};
  }
}

class Upload implements GuestMediaTransport {
  @override
  Future<void> put(Uri uri, File file, String contentType) async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // Real file setup lives in setUpAll/tearDownAll (real async zone):
  // awaiting dart:io inside a testWidgets body deadlocks the FakeAsync
  // microtask queue before the first pump ever flushes it.
  late final Directory dir;
  setUpAll(() async {
    dir = await Directory.systemTemp.createTemp('guest-photo-consent-');
  });
  tearDownAll(() async {
    if (await dir.exists()) {
      await dir.delete(recursive: true);
    }
  });
  testWidgets(
    'consent is unchecked and canceling explicit upload confirmation requests no capability',
    (tester) async {
      tester.view.physicalSize = const Size(800, 2000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      SharedPreferences.setMockInitialValues({});
      // Minimal valid 1x1 PNG (content-sniffed by the image codec; the
      // file name is irrelevant) so the preview Image.file decodes cleanly.
      final photo = File('${dir.path}/synthetic.jpg')
        ..writeAsBytesSync(<int>[
          137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0,
          0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 144, 119, 83, 222, 0, 0, 0,
          12, 73, 68, 65, 84, 8, 153, 99, 248, 207, 192, 0, 0, 3, 1, 1,
          0, 24, 221, 141, 219, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96,
          130,
        ]);
      final boundary = Boundary();
      final session = GuestMediaSession(
        client: GuestMediaClient(invoker: boundary, transport: Upload()),
        partyId: 'party',
        deviceId: 'device',
        tempDirectory: () async => dir,
      );
      await tester.pumpWidget(
        MaterialApp(
          home: GuestPhotoScreen(session: session, picker: Picker(photo)),
        ),
      );
      await tester.pump();
      expect(find.textContaining('temporarily retained'), findsOneWidget);
      expect(
        tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        false,
      );
      await tester.tap(find.text('Choose photo'));
      await tester.pump(const Duration(milliseconds: 500));
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pump(const Duration(milliseconds: 500));
      await tester.tap(find.text('Review and upload'));
      await tester.pump(const Duration(milliseconds: 500));
      await tester.tap(find.text('Cancel'));
      await tester.pump(const Duration(milliseconds: 500));
      expect(boundary.requests, 0);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
