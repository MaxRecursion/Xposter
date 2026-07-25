/**
 * Polls X trending topics on a fixed interval.
 *
 * Kept separate from the reply pipeline so trend data is already warm when a
 * run fires — fetching 100 trends inline would add latency to every reply.
 */
import { getBooleanSetting, getIntSetting } from '../storage/settings.js';
import { logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { refreshTrends } from '../trends/x_trends.js';

const BOOT_DELAY_MS = 45_000;

let _tickHandle: NodeJS.Timeout | null = null;
let _bootHandle: NodeJS.Timeout | null = null;
let _running = false;

export function startTrendRefreshScheduler(): void {
  if (_tickHandle || _bootHandle) return;
  if (process.env.X_TRENDS_ENABLED === 'false') {
    logger.info('Trend refresh scheduler disabled via X_TRENDS_ENABLED');
    return;
  }

  const intervalMs = getIntSetting('trend_refresh_minutes', 30, 10, 240) * 60_000;

  // Let the browser session and DB settle before the first poll.
  _bootHandle = setTimeout(() => {
    void runRefresh();
    _tickHandle = setInterval(() => { void runRefresh(); }, intervalMs);
  }, BOOT_DELAY_MS);

  logger.info('Trend refresh scheduler started', { intervalMinutes: intervalMs / 60_000 });
}

export function stopTrendRefreshScheduler(): void {
  if (_tickHandle) { clearInterval(_tickHandle); _tickHandle = null; }
  if (_bootHandle) { clearTimeout(_bootHandle); _bootHandle = null; }
}

async function runRefresh(): Promise<void> {
  if (_running) return;
  if (!getBooleanSetting('system_running', true)) return;
  if (!getBooleanSetting('trend_replies_enabled', true)) return;

  _running = true;
  try {
    const counts = await refreshTrends();
    logEvent('TRENDS_REFRESHED', `global=${counts.global} india=${counts.india}`);
  } catch (err) {
    // refreshTrends already swallows per-location failures; this is a backstop.
    logger.warn('Trend refresh tick failed', { err: String(err).slice(0, 200) });
  } finally {
    _running = false;
  }
}
