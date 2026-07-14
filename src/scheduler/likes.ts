/**
 * Likes scheduler — distributes 100 topic-relevant likes across the active
 * window each day. Runs a small like session every ~15 minutes; each session
 * likes only enough to stay on pace for the daily target.
 */

import { getBooleanSetting, getIntSetting } from '../storage/settings.js';
import { logger } from '../utils/logger.js';
import { getLikesCountToday, runLikeSession } from '../browser/likes.js';
import { logEvent } from '../storage/queries.js';

const TICK_INTERVAL_MS = 15 * 60_000;   // check every 15 minutes
const DEFAULT_DAILY_TARGET = 100;

let _handle: NodeJS.Timeout | null = null;
let _running = false;

export function startLikesScheduler(): void {
  if (_handle) return;
  _handle = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
  logger.info('Likes scheduler started', { tickIntervalMin: 15, dailyTarget: DEFAULT_DAILY_TARGET });
}

export function stopLikesScheduler(): void {
  if (_handle) {
    clearInterval(_handle);
    _handle = null;
  }
}

async function tick(): Promise<void> {
  if (_running) return;
  if (!getBooleanSetting('system_running', true)) return;
  if (!getBooleanSetting('likes_enabled', true)) return;

  const now = new Date();
  const hour = now.getHours();
  const activeStart = getIntSetting('active_window_start_hour', 9, 0, 23);
  const activeEnd   = getIntSetting('active_window_end_hour',   22, 1, 24);
  if (hour < activeStart || hour >= activeEnd) return;

  const dailyTarget  = getIntSetting('likes_per_day', DEFAULT_DAILY_TARGET, 0, 500);
  const likedToday   = getLikesCountToday();

  if (likedToday >= dailyTarget) return;

  // How many ticks remain in the active window today?
  const minutesLeft   = Math.max(1, (activeEnd - hour) * 60 - now.getMinutes());
  const ticksLeft     = Math.max(1, Math.floor(minutesLeft / 15));
  const remaining     = dailyTarget - likedToday;
  // Like enough per tick to finish on pace, capped at 8 per session to look human
  const targetThisTick = Math.min(8, Math.ceil(remaining / ticksLeft));
  if (targetThisTick <= 0) return;

  _running = true;
  logEvent('LIKE_SESSION_START', `likedToday=${likedToday} target=${dailyTarget} thisSession=${targetThisTick}`);
  logger.info('Like session tick', { likedToday, dailyTarget, targetThisTick });

  try {
    const result = await runLikeSession(targetThisTick);
    logger.info('Like session tick done', result);
  } catch (err) {
    logger.error('Like session tick error', { err: String(err) });
  } finally {
    _running = false;
  }
}
