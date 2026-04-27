import { fetchOurFollowers } from '../browser/followers.js';
import {
  enqueueFollowerEvent, listAccounts, setFollowerState, getAccount,
} from '../storage/accounts.js';
import { getSetting, logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { sendFollowerNotification } from '../notifications/ntfy.js';
import { classifyAccount } from '../pipeline/classifier.js';

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours
let _interval: NodeJS.Timeout | null = null;

export function startFollowerSync(): void {
  if (_interval) return;

  // First sync 5 minutes after boot (let everything settle)
  setTimeout(() => { void runFollowerSync(); }, 5 * 60_000);
  _interval = setInterval(() => { void runFollowerSync(); }, SYNC_INTERVAL_MS);

  logger.info('Follower sync scheduled', { everyHours: SYNC_INTERVAL_MS / 3_600_000 });
}

export function stopFollowerSync(): void {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

/**
 * One pass:
 *   1. Read X_HANDLE env var (our own handle). If missing, log and skip.
 *   2. Fetch follower handles via Playwright.
 *   3. Diff against accounts.following_us = 1 in DB.
 *   4. For each new follower:
 *        - mark following_us = 1
 *        - classify (cached) so we have bio/classification before notifying
 *        - enqueue NEW_FOLLOWER event (PENDING)
 *        - send a single ntfy notification
 */
export async function runFollowerSync(): Promise<{ newFollowers: number; total: number }> {
  const me = process.env.X_HANDLE;
  if (!me) {
    logger.warn('X_HANDLE not set in .env — skipping follower sync');
    return { newFollowers: 0, total: 0 };
  }

  if (getSetting('system_running', 'true') !== 'true') {
    return { newFollowers: 0, total: 0 };
  }

  logEvent('FOLLOWER_SYNC_START');
  let followers: string[] = [];
  try {
    followers = await fetchOurFollowers(me, 200);
  } catch (err) {
    logger.error('Follower fetch failed', { err: String(err) });
    logEvent('FOLLOWER_SYNC_ERROR', String(err));
    return { newFollowers: 0, total: 0 };
  }

  const knownFollowers = new Set(
    listAccounts({ limit: 1000 })
      .filter((a) => a.following_us === 1)
      .map((a) => a.handle.toLowerCase()),
  );

  const newOnes: string[] = [];
  for (const handle of followers) {
    setFollowerState(handle, true);
    if (!knownFollowers.has(handle.toLowerCase())) newOnes.push(handle);
  }

  // Cap notifications: avoid spamming on first run after a long absence
  const maxNotifyPerRun = 5;
  for (const handle of newOnes.slice(0, maxNotifyPerRun)) {
    try {
      const account = await classifyAccount(handle, null, { fetchProfileIfMissing: true });
      const eventId = enqueueFollowerEvent(handle, 'NEW_FOLLOWER',
        `classification=${account.classification ?? 'UNKNOWN'}; followers=${account.follower_count_seen}`);
      if (eventId !== null) {
        await sendFollowerNotification(eventId, handle, account).catch((err) => {
          logger.warn('Follower notification failed', { handle, err: String(err) });
        });
        logEvent('NEW_FOLLOWER_QUEUED', `@${handle}`, undefined);
      }
    } catch (err) {
      logger.warn('Failed to enqueue new follower', { handle, err: String(err) });
    }
  }

  if (newOnes.length > maxNotifyPerRun) {
    logEvent(
      'NEW_FOLLOWER_BATCH_TRUNCATED',
      `${newOnes.length} new followers detected; queued ${maxNotifyPerRun}`,
    );
  }

  logEvent('FOLLOWER_SYNC_COMPLETE', `total=${followers.length} new=${newOnes.length}`);
  logger.info('Follower sync complete', { total: followers.length, new: newOnes.length });
  return { newFollowers: newOnes.length, total: followers.length };
}
