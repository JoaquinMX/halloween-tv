import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tv_app/src/playback/asset_tile_video_controller.dart';
import 'package:tv_app/src/playback/file_tile_video_controller.dart';
import 'package:tv_app/src/playback/tile_video_controller.dart';

void main() {
  // Factory mapping is pinned here (verified-file path and bundled asset
  // stay on their own controller types). Missing/corrupt-file behavior is
  // covered at integration level: wall_test.dart's rollback cases drive a
  // failing local decoder back to the bundled source through this factory.
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'the production controller factory maps verified files to file playback',
    () async {
      final Directory root = await Directory.systemTemp.createTemp(
        'tv-file-controller-',
      );
      addTearDown(() => root.delete(recursive: true));
      final File media = File('${root.path}/verified-camera.mp4');
      await media.writeAsBytes(<int>[0, 1, 2, 3], flush: true);

      final TileVideoController controller = createTileVideoController(
        cameraId: 'CAM-01',
        source: LocalFileSource(media.absolute.path),
      );

      expect(controller, isA<FileTileVideoController>());
      expect((controller as FileTileVideoController).path, media.absolute.path);
      await controller.dispose();
    },
  );

  test('bundled fixtures remain explicit asset inputs', () async {
    final TileVideoController controller = createTileVideoController(
      cameraId: 'CAM-01',
      source: const BundledAssetSource('assets/cam01.mp4'),
    );
    expect(controller, isA<AssetTileVideoController>());
    await controller.dispose();
  });
}
