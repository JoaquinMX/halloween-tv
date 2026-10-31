/// Live channel wiring: every Firestore-scoped client must carry the
/// resolved `TV_CHANNEL_ID`, never the hardcoded CCTV camera-feed constant.
///
/// All five live paths (URL signer, expired-URL refresher, live wall
/// session, guest-code client, host-invite client) are built through the
/// real [PlaybackDependencies.create] production composition; only the
/// callable network boundary is substituted with recording fakes (the same
/// seam pattern used across the repo), so the assertions exercise prod
/// constructors and the prod refresher closure.
library;

import 'dart:io';

import 'package:channel_cctv/channel_cctv.dart';
import 'package:core_playlist/core_playlist.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:infra_firestore/infra_firestore.dart';
import 'package:infra_signed_urls/infra_signed_urls.dart';
import 'package:tv_app/src/bootstrap/playback_dependencies.dart';
import 'package:tv_app/src/config/backend_config.dart';
import 'package:tv_app/src/wall/wall_boot.dart';

import 'support/fakes.dart';

/// Recording fake at the delivery callable boundary (prod
/// [FirebaseDeliveryClient] constructor runs unchanged).
final class _RecordingDeliveryInvoker implements FirebaseCallableInvoker {
  _RecordingDeliveryInvoker(this.payloads, this.response);

  final List<Map<String, Object?>> payloads;
  final Map<String, Object?> response;

  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async {
    payloads.add(payload);
    return response;
  }
}

/// Manifest callable stub: [PlaybackDependencies.create] never subscribes,
/// so this is only present to keep the seam complete.
final class _EmptyManifestInvoker implements FirebaseManifestCallableInvoker {
  @override
  Future<Object?> call(String name, Map<String, Object?> payload) async =>
      <String, Object?>{};
}

const String _liveChannel = 'haunt-live-9';
const String _partyId = 'haunt-party-1';
const String _deviceId = 'tv-room-1';

Map<String, String> _liveValues({String channelId = _liveChannel}) =>
    <String, String>{
      'BACKEND_MODE': 'firebase',
      'TV_PARTY_ID': _partyId,
      'TV_DEVICE_ID': _deviceId,
      'TV_CHANNEL_ID': channelId,
      'FIREBASE_PROJECT_ID': 'demo-haunted-tv',
      'FIREBASE_APP_ID': '1:123:web:abc',
      'FIREBASE_API_KEY': 'client-placeholder',
      'FIREBASE_MESSAGING_SENDER_ID': '123',
    };

ClipDescriptor _clip(String shaHex) => ClipDescriptor(
  id: 'clip-01',
  cameraId: 'CAM-01',
  storageObjectId: 'assets/cam01.mp4',
  sha256: shaHex,
  sizeBytes: 4,
  duration: const Duration(seconds: 2),
  mimeType: 'video/mp4',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('all five live clients use the resolved party channel', () async {
    final List<Map<String, Object?>> deliveryPayloads = <Map<String, Object?>>[];
    final List<Map<String, Object?>> guestPayloads = <Map<String, Object?>>[];
    final List<Map<String, Object?>> hostPayloads = <Map<String, Object?>>[];
    const String clipSha =
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    final String expiry = DateTime.now()
        .toUtc()
        .add(const Duration(hours: 1))
        .toIso8601String();
    final Map<String, Object?> deliveryResponse = <String, Object?>{
      'manifestVersion': 3,
      'manifestHash':
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'clips': <Object?>[
        <String, Object?>{
          'cameraId': 'CAM-01',
          'sha256': clipSha,
          'url': 'https://cdn.example.com/live.mp4',
          'expiresAt': expiry,
        },
        <String, Object?>{
          'cameraId': 'CAM-02',
          'sha256':
              'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          'url': 'https://cdn.example.com/live2.mp4',
          'expiresAt': expiry,
        },
        <String, Object?>{
          'cameraId': 'CAM-03',
          'sha256':
              'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          'url': 'https://cdn.example.com/live3.mp4',
          'expiresAt': expiry,
        },
        <String, Object?>{
          'cameraId': 'CAM-04',
          'sha256':
              'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          'url': 'https://cdn.example.com/live4.mp4',
          'expiresAt': expiry,
        },
      ],
    };
    final Directory root = await Directory.systemTemp.createTemp(
      'tv-live-channel-',
    );
    addTearDown(() => root.delete(recursive: true));

    final PlaybackDependencies dependencies = await PlaybackDependencies.create(
      config: BackendConfig.parse(_liveValues()),
      supportDirectory: Directory('${root.path}/support'),
      stagingDirectory: Directory('${root.path}/temporary'),
      firebaseBootstrap: (_) async {},
      deliveryInvokerOverride: _RecordingDeliveryInvoker(
        deliveryPayloads,
        deliveryResponse,
      ),
      manifestInvokerOverride: _EmptyManifestInvoker(),
      guestCodeInvokerOverride:
          (String name, Map<String, Object?> payload) async {
            guestPayloads.add(payload);
            return <String, Object?>{
              'partyId': _partyId,
              'channelId': _liveChannel,
              'tvDeviceId': _deviceId,
              'devices': <Object?>[],
            };
          },
      hostInviteInvokerOverride:
          (String name, Map<String, Object?> payload) async {
            hostPayloads.add(payload);
            return <String, Object?>{
              'partyId': _partyId,
              'channelId': _liveChannel,
              'inviteToken': 'invite-token-abc',
              'pairingCode': '123456',
              'expiresAt': expiry,
            };
          },
    );

    // Resolved channel itself.
    expect(dependencies.channelId, _liveChannel);
    expect(dependencies.channelId, isNot(hauntedSurveillanceChannelId));

    // 1. URL signer.
    expect(dependencies.urlSigner, isNotNull);
    expect(dependencies.urlSigner!.channelId, _liveChannel);

    // 2. Expired-URL refresher runs the prod closure against the fake
    // delivery boundary and must request the live channel.
    expect(dependencies.expiredUrlRefresher, isNotNull);
    final Uri refreshed = await dependencies.expiredUrlRefresher!(
      _clip(clipSha),
      Uri.parse('https://cdn.example.com/expired.mp4'),
    );
    expect(refreshed, Uri.parse('https://cdn.example.com/live.mp4'));
    expect(deliveryPayloads, hasLength(1));
    expect(deliveryPayloads.single['channelId'], _liveChannel);
    expect(deliveryPayloads.single['partyId'], _partyId);

    // 3. Live wall session.
    expect(dependencies.liveSession, isNotNull);
    expect(dependencies.liveSession!.channelId, _liveChannel);
    expect(dependencies.liveSession!.partyId, _partyId);

    // 4. Guest-code client: constructor scope plus a real listing
    // round-trip echoing the live channel.
    expect(dependencies.guestCodeClient, isNotNull);
    expect(dependencies.guestCodeClient!.channelId, _liveChannel);
    final listing = await dependencies.guestCodeClient!.fetchListing();
    expect(listing.channelId, _liveChannel);
    expect(guestPayloads.single['channelId'], _liveChannel);

    // 5. Host-invite client: constructor scope plus a real invite
    // round-trip bound to the live channel.
    expect(dependencies.hostInviteClient, isNotNull);
    expect(dependencies.hostInviteClient!.channelId, _liveChannel);
    final invite = await dependencies.hostInviteClient!.createInvite();
    expect(invite.channelId, _liveChannel);
    expect(hostPayloads.single['channelId'], _liveChannel);

    // The wall boot inherits the resolved channel (cached-manifest and
    // fixture comparisons follow it).
    final WallBoot boot = dependencies.createWallBoot(
      store: InMemoryManifestStore(),
    );
    expect(boot.channelId, _liveChannel);
    expect(boot.partyId, _partyId);
  });

  test('offline composition keeps the CCTV default and no live clients', () async {
    final Directory root = await Directory.systemTemp.createTemp(
      'tv-offline-channel-',
    );
    addTearDown(() => root.delete(recursive: true));

    final PlaybackDependencies dependencies = await PlaybackDependencies.create(
      config: BackendConfig.parse(const <String, String>{}),
      supportDirectory: Directory('${root.path}/support'),
      stagingDirectory: Directory('${root.path}/temporary'),
      firebaseBootstrap: (_) async {},
    );

    expect(dependencies.channelId, hauntedSurveillanceChannelId);
    expect(dependencies.urlSigner, isNull);
    expect(dependencies.expiredUrlRefresher, isNull);
    expect(dependencies.liveSession, isNull);
    expect(dependencies.guestCodeClient, isNull);
    expect(dependencies.hostInviteClient, isNull);

    final WallBoot boot = dependencies.createWallBoot(
      store: InMemoryManifestStore(),
    );
    expect(boot.channelId, hauntedSurveillanceChannelId);
  });
}
