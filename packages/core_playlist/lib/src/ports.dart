import 'entities.dart';

/// Port for observing the current playlist for a party.
abstract class PlaylistPort {
  Stream<Playlist> watchCurrent(String partyId);
}
