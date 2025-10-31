import * as functions from 'firebase-functions';
import { publishPlaylist } from './publishPlaylist';
import { ackDownload } from './ackDownload';
import { sweeperCron } from './sweeperCron';

export const publishPlaylistFn = functions
  .region('us-central1')
  .https.onCall(publishPlaylist);

export const ackDownloadFn = functions
  .region('us-central1')
  .https.onRequest(ackDownload);

export const sweeperCronFn = functions
  .region('us-central1')
  .pubsub.schedule('every 30 minutes')
  .onRun(sweeperCron);
