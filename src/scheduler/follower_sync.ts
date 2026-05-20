import { fetchOurFollowers, resolveOwnHandle } from '../browser/followers.js';
import {
  listAccounts, setFollowerState, getAccount,
} from '../storage/accounts.js';
import { enqueueFollowerEvent, autoApproveFollowBack, setFollowerEventStatus } from '../storage/follower_events.js';
import { logEvent } from '../storage/queries.js';
import { getBooleanSetting, getListSetting, getIntSetting } from '../storage/settings.js';
import { logger } from '../utils/logger.js';
import { sendFollowerNotification } from '../notifications/ntfy.js';
import { classifyAccount } from '../pipeline/classifier.js';

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours
let _interval: NodeJS.Timeout | null = null;
let _bootTimer: NodeJS.Timeout | null = null;

export interface FollowerSyncResult {
  ok: boolean;
  newFollowers: number;
  queued: number;
  total: number;
  handle?: string;
  reason?: string;
  message?: string;
}

export function startFollowerSync(): void {
  if (_interval) return;

  // First sync 5 minutes after boot (let everything settle)
  _bootTimer = setTimeout(() => {
    void runFollowerSync().catch((err) => logger.error('Follower sync failed', { err }));
  }, 5 * 60_000);
  _interval = setInterval(() => {
    void runFollowerSync().catch((err) => logger.error('Follower sync failed', { err }));
  }, SYNC_INTERVAL_MS);

  logger.info('Follower sync scheduled', { everyHours: SYNC_INTERVAL_MS / 3_600_000 });
}

export function stopFollowerSync(): void {
  if (_bootTimer) { clearTimeout(_bootTimer); _bootTimer = null; }
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
export async function runFollowerSync(): Promise<FollowerSyncResult> {
  const me = await resolveOwnHandle();
  if (!me) {
    const message = 'Could not determine your X handle. Set X_HANDLE in .env or log in to X in the browser profile.';
    logger.warn(message);
    logEvent('FOLLOWER_SYNC_SKIPPED', message);
    return { ok: false, reason: 'missing_handle', message, newFollowers: 0, queued: 0, total: 0 };
  }

  if (!getBooleanSetting('system_running', true)) {
    return {
      ok: false,
      reason: 'system_paused',
      message: 'System is paused. Resume it before syncing followers.',
      newFollowers: 0,
      queued: 0,
      total: 0,
      handle: me,
    };
  }

  logEvent('FOLLOWER_SYNC_START');
  let followers: string[] = [];
  try {
    followers = await fetchOurFollowers(me, 200);
  } catch (err) {
    const message = `Follower fetch failed: ${String(err)}`;
    logger.error('Follower fetch failed', { err: String(err) });
    logEvent('FOLLOWER_SYNC_ERROR', message);
    return { ok: false, reason: 'fetch_failed', message, newFollowers: 0, queued: 0, total: 0, handle: me };
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

  // Cap to avoid thundering-herd on first run after a long absence
  const maxPerRun = 5;
  const blocklist = getListSetting('blocklist_classifications', ['BOT', 'SPAM', 'BRAND_PROMO'])
    .map((v) => v.toUpperCase());
  const windowHours = getIntSetting('follow_back_window_hours', 24, 1, 48);
  const now = Math.floor(Date.now() / 1000);

  let queued = 0;
  for (const handle of newOnes.slice(0, maxPerRun)) {
    try {
      const account = await classifyAccount(handle, null, { fetchProfileIfMissing: true });
      const cls = (account.classification ?? 'UNKNOWN').toUpperCase();
      const isBlocked = blocklist.includes(cls);

      const detail = `classification=${cls}; followers=${account.follower_count_seen}; auto=${!isBlocked}`;
      const eventId = enqueueFollowerEvent(handle, 'NEW_FOLLOWER', detail);

      if (eventId !== null) {
        if (isBlocked) {
          // Auto-skip bots, spam, brand accounts
          setFollowerEventStatus(eventId, 'SKIPPED', `blocklisted: ${cls}`);
          logEvent('NEW_FOLLOWER_SKIPPED', `@${handle} (${cls} is blocklisted)`, undefined);
          logger.info('Auto-skipped new follower (blocklisted)', { handle, cls });
        } else {
          // Schedule follow-back at a random time within the window
          const minDelay = 30 * 60;  // minimum 30 minutes
          const maxDelay = windowHours * 3600;
          const delay = minDelay + Math.floor(Math.random() * (maxDelay - minDelay));
          const scheduledAt = now + delay;
          autoApproveFollowBack(eventId, scheduledAt, detail);
          queued++;

          const scheduledTime = new Date(scheduledAt * 1000).toLocaleTimeString('en-IN', {
            hour: '2-digit', minute: '2-digit', hour12: true,
          });
          logEvent('NEW_FOLLOWER_SCHEDULED', `@${handle} → follow-back at ${scheduledTime}`, undefined);
          logger.info('Scheduled auto follow-back', { handle, cls, scheduledAt, scheduledTime });

          // Send informational notification (user can still skip via dashboard)
          await sendFollowerNotification(eventId, handle, account).catch((err) => {
            logger.warn('Follower notification failed', { handle, err: String(err) });
          });
        }
      }
    } catch (err) {
      logger.warn('Failed to process new follower', { handle, err: String(err) });
    }
  }

  if (newOnes.length > maxPerRun) {
    logEvent(
      'NEW_FOLLOWER_BATCH_TRUNCATED',
      `${newOnes.length} new followers; processed ${maxPerRun}`,
    );
  }

  logEvent('FOLLOWER_SYNC_COMPLETE', `total=${followers.length} new=${newOnes.length}`);
  logger.info('Follower sync complete', { total: followers.length, new: newOnes.length });
  return { ok: true, newFollowers: newOnes.length, queued, total: followers.length, handle: me };
}
