import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

initializeApp();

export interface PublishPlaylistPayload {
  partyId: string;
  layout: '2x2';
  clips: Array<{
    id: string;
    label: string;
    storagePath: string;
    localKey: string;
    checksumSha256: string;
    sizeBytes: number;
  }>;
  overlay: {
    timestampFmt: string;
    glitchIntensity: number;
  };
  expiresAt: string;
}

export async function publishPlaylist(data: PublishPlaylistPayload) {
  if (!data.partyId) {
    throw new Error('partyId is required');
  }
  if (!data.clips || data.clips.length !== 4) {
    throw new Error('Exactly four clips are required for 2x2 layout');
  }

  const firestore = getFirestore();
  const storage = getStorage().bucket();
  const version = Date.now();

  const clips = await Promise.all(
    data.clips.map(async (clip) => {
      const [signedUrl] = await storage
        .file(clip.storagePath)
        .getSignedUrl({ action: 'read', expires: Date.now() + 15 * 60 * 1000 });
      return {
        id: clip.id,
        label: clip.label,
        localKey: clip.localKey,
        signedUrl,
        checksumSha256: clip.checksumSha256,
        sizeBytes: clip.sizeBytes,
      };
    })
  );

  await firestore
    .collection('parties')
    .doc(data.partyId)
    .collection('playlist')
    .doc('current')
    .set({
      version,
      layout: data.layout,
      overlay: data.overlay,
      expiresAt: new Date(data.expiresAt),
      clips,
    });

  return { version };
}
