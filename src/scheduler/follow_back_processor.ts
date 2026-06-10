/**
 * follow_back_processor.ts
 *
 * Runs every 5 minutes. Picks up APPROVED follower_events whose scheduled_at
 * has arrived, then executes the follow-back action via Playwright.
 * Respects the daily follow-back cap from settings.
 */

import { getDueScheduledFollowBacks, setFollowerEventStatus, countActionedFollowBacksToday } from '../storage/follower_events.js';
import { setFollowingState } from '../storage/accounts.js';
import { followBack } from '../browser/followers.js';
import { getBooleanSetting, getIntSetting } from '../storage/settings.js';
import { logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';

const PROCESSOR_INTERVAL_MS = 5 * 60_000; // every 5 minutes
let _interval: NodeJS.Timeout | null = null;

export function startFollowBackProcessor(): void {
  if (_interval) return;
  _interval = setInterval(() => {
    void processScheduledFollowBacks().catch((err) =>
      logger.error('Follow-back processor error', { err: String(err) }),
    );
  }, PROCESSOR_INTERVAL_MS);
  logger.info('Follow-back processor started (checks every 5 min)');
}

export function stopFollowBackProcessor(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

export async function processScheduledFollowBacks(): Promise<void> {
  if (!getBooleanSetting('system_running', true)) return;

  const due = getDueScheduledFollowBacks();
  if (due.length === 0) return;

  const maxPerDay = getIntSetting('max_follow_backs_per_day', 15, 0, 100);
  const doneToday = countActionedFollowBacksToday();
  const remaining = maxPerDay - doneToday;

  if (remaining <= 0) {
    logger.info('Daily follow-back cap reached, skipping processor run', { maxPerDay, doneToday });
    return;
  }

  logger.info('Processing due follow-backs', { due: due.length, remaining });

  const toProcess = due.slice(0, remaining);
  for (const event of toProcess) {
    const handle = event.account_handle;
    logger.info('Executing scheduled follow-back', { handle, scheduledAt: event.scheduled_at });

    try {
      const ok = await followBack(handle);
      if (ok) {
        setFollowingState(handle, true);
        setFollowerEventStatus(event.id, 'ACTIONED', 'auto follow-back executed');
        logEvent('FOLLOW_BACK_ACTIONED', `@${handle} (auto-scheduled)`);
        logger.info('Auto follow-back succeeded', { handle });
      } else {
        setFollowerEventStatus(event.id, 'ERROR', 'follow button not found / click failed');
        logEvent('FOLLOW_BACK_ERROR', `@${handle}: button not clickable (auto)`);
        logger.warn('Auto follow-back failed — button not found', { handle });
      }
    } catch (err) {
      const msg = String(err).slice(0, 200);
      setFollowerEventStatus(event.id, 'ERROR', msg);
      logEvent('FOLLOW_BACK_ERROR', `@${handle}: ${msg}`);
      logger.error('Auto follow-back threw', { handle, err: msg });
    }

    // Small random delay between follow actions to look human
    const delay = 8_000 + Math.floor(Math.random() * 7_000); // 8–15s
    await new Promise((r) => setTimeout(r, delay));
  }
}
