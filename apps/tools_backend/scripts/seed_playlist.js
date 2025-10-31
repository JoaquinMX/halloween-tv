#!/usr/bin/env node
const admin = require('firebase-admin');

async function main() {
  admin.initializeApp();
  const db = admin.firestore();
  const partyId = process.argv[2] || 'demo-party';

  await db.collection('parties').doc(partyId).set({
    name: 'Halloween Surveillance',
    status: 'live',
    layout: '2x2',
    theme: 'cctv',
  }, { merge: true });

  await db.collection('parties').doc(partyId).collection('playlist').doc('current').set({
    version: 1,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    overlay: { timestampFmt: 'yyyy-MM-dd HH:mm:ss', glitchIntensity: 0.4 },
    clips: [1, 2, 3, 4].map((index) => ({
      id: `clip-${index}`,
      label: `CAM-0${index}`,
      localKey: `cam0${index}_v1.mp4`,
      sizeBytes: 5 * 1024 * 1024,
      signedUrl: `https://example.com/clip${index}.mp4`,
      checksumSha256: 'test-checksum',
    })),
  });

  console.log('Seeded playlist for party', partyId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
