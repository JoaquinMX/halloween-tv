import { getStorage } from 'firebase-admin/storage';

export async function sweeperCron() {
  const storage = getStorage().bucket();
  const cutoff = Date.now() - 60 * 60 * 1000;
  const prefixes = ['ingest/', 'generated/'];

  for (const prefix of prefixes) {
    const [files] = await storage.getFiles({ prefix });
    const deletions = files
      .filter((file) => file.metadata && file.metadata.updated && Date.parse(file.metadata.updated) < cutoff)
      .map((file) => file.delete());
    await Promise.all(deletions);
  }
}
