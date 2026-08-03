import { publishReply } from './reply_publisher.js';
import { claimPostRetry, getPost, getPostsDueForRetry, logEvent } from '../storage/queries.js';
import { getBooleanSetting } from '../storage/settings.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';

export async function runReplyRetryQueue(): Promise<{
  due: number;
  posted: number;
  failed: number;
}> {
  if (!getBooleanSetting('system_running', true)) {
    return { due: 0, posted: 0, failed: 0 };
  }

  const due = getPostsDueForRetry(3);
  let posted = 0;
  let failed = 0;

  for (let i = 0; i < due.length; i++) {
    const retry = due[i];
    if (!claimPostRetry(retry.id)) continue;
    const claimed = getPost(retry.id);
    const replyText = claimed?.final_reply ?? claimed?.generated_reply;
    if (!claimed || !replyText) {
      failed++;
      continue;
    }

    logEvent('POST_RETRY_START', `attempt=${claimed.posting_attempts}`, claimed.id);
    const outcome = await publishReply(claimed, replyText, null, {
      attemptAlreadyCounted: true,
    });
    if (outcome === 'posted') posted++;
    else failed++;

    if (i < due.length - 1) {
      await delay(randomBetween(3000, 6000));
    }
  }

  if (due.length > 0) {
    logger.info('Reply retry queue processed', { due: due.length, posted, failed });
  }
  return { due: due.length, posted, failed };
}
