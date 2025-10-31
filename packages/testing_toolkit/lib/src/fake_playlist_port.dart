import 'dart:async';

import 'package:core_playlist/core_playlist.dart';

/// Fake playlist port that can emit queued playlists.
class FakePlaylistPort implements PlaylistPort {
  FakePlaylistPort();

  final StreamController<Playlist> _controller = StreamController<Playlist>.broadcast();

  void emit(Playlist playlist) => _controller.add(playlist);

  @override
  Stream<Playlist> watchCurrent(String partyId) => _controller.stream;
}
