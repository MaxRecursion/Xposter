import { scrapeAudienceHeatmap } from '../browser/audience.js';
import { saveHeatmap, getLatestHeatmap } from '../storage/audience.js';
import { invalidateHeatmapCache } from './audience_weights.js';
import { logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { getBooleanSetting, setSetting } from '../storage/settings.js';

/**
 * Daily refresh of the audience-activity heatmap.
 *
 * X aggregates the chart over the trailing 28 days — once a day is plenty.
 * On boot we run a sync only if our latest snapshot is stale (>22h), so a
 * normal restart doesn't waste a scrape.
 */

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STALE_AFTER_S = 22 * 60 * 60;
const BOOT_DELAY_MS = 60_000;  // let the browser context warm up

let _interval: NodeJS.Timeout | null = null;
let _bootTimer: NodeJS.Timeout | null = null;
let _running = false;

export function startAudienceSync(): void {
  if (_interval) return;
  if (!getBooleanSetting('audience_sync_enabled', true)) {
    logger.info('Audience sync disabled — slot times will use uniform weighting');
    return;
  }

  _bootTimer = setTimeout(() => {
    const latest = getLatestHeatmap();
    const ageS = latest ? Math.floor(Date.now() / 1000) - latest.fetched_at : Infinity;
    if (ageS > STALE_AFTER_S) {
      void runAudienceSync('boot');
    } else {
      logger.info('Audience heatmap is fresh — skipping boot fetch', {
        age_hours: Math.round(ageS / 3600),
      });
    }
  }, BOOT_DELAY_MS);

  _interval = setInterval(() => { void runAudienceSync('interval'); }, REFRESH_INTERVAL_MS);
  logger.info('Audience sync started (daily refresh)');
}

export function stopAudienceSync(): void {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_bootTimer) { clearTimeout(_bootTimer); _bootTimer = null; }
}

export async function runAudienceSync(
  trigger: 'boot' | 'interval' | 'manual' = 'manual',
): Promise<{ ok: boolean; error?: string; cells?: number }> {
  if (_running) return { ok: false, error: 'sync already running' };
  if (!getBooleanSetting('system_running', true)) {
    return { ok: false, error: 'system paused' };
  }
  if (trigger !== 'manual' && !getBooleanSetting('audience_sync_enabled', true)) {
    return { ok: false, error: 'audience sync disabled' };
  }
  _running = true;
  logEvent('AUDIENCE_SYNC_START', trigger);

  try {
    const data = await scrapeAudienceHeatmap();

    // A Premium gate is a permanent answer, not a flaky scrape: turn the job
    // off so it stops costing a page load a day, and leave a setting the user
    // can flip back if the account is upgraded. Slot weighting already falls
    // back to uniform random with no heatmap, so nothing downstream breaks.
    if (data.premiumRequired) {
      setSetting('audience_sync_enabled', 'false');
      stopAudienceSync();
      logEvent('AUDIENCE_SYNC_DISABLED', 'X Premium required for audience analytics');
      logger.warn('Audience analytics requires X Premium — sync disabled', {
        reEnable: 'set audience_sync_enabled=true after upgrading',
      });
      return { ok: false, error: 'premium_required' };
    }

    if (!data.ok || !data.matrix) {
      logEvent('AUDIENCE_SYNC_FAILED', data.error ?? 'unknown error');
      logger.warn('Audience scrape failed', { error: data.error });
      return { ok: false, error: data.error };
    }
    saveHeatmap(data.matrix, data.levels ?? null, `trigger=${trigger}`);
    invalidateHeatmapCache();
    logEvent('AUDIENCE_SYNC_COMPLETE', `${data.cellCount} cells`);
    logger.info('Audience heatmap saved', { cells: data.cellCount });
    return { ok: true, cells: data.cellCount };
  } catch (err) {
    logger.error('Audience sync threw', { err: String(err) });
    logEvent('AUDIENCE_SYNC_ERROR', String(err));
    return { ok: false, error: String(err) };
  } finally {
    _running = false;
  }
}
