import { Request, Response } from 'firebase-functions';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

interface AckPayload {
  partyId: string;
  version: number;
  deviceId: string;
  clips: Array<{ localKey: string; checksum: string }>;
}

export async function ackDownload(req: Request, res: Response) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }
  const body = req.body as AckPayload;
  if (!body.partyId || !body.version) {
    res.status(400).send('Invalid payload');
    return;
  }

  const firestore = getFirestore();
  const storage = getStorage().bucket();

  await firestore
    .collection('parties')
    .doc(body.partyId)
    .collection('acks')
    .doc(`${body.version}_${body.deviceId}`)
    .set({
      receivedAt: new Date().toISOString(),
      clips: body.clips,
    });

  await storage.deleteFiles({ prefix: `generated/${body.partyId}/v${body.version}/` });

  res.status(200).send({ ok: true });
}
