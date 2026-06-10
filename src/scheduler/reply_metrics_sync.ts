import {
  getInteractionsNeedingMetricSync, refreshAccountReplyStats, updateInteractionMetrics,
} from '../storage/interactions.js';
import { scrapeEngagement } from '../browser/impressions.js';
import { getBooleanSetting } from '../storage/settings.js';
import { logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';

/**
 * Periodic engagement sync for replies we posted (mirrors the original-post
 * impression sync in original_posts.ts). Feeds interactions.success_score —
 * which the neural memory and the scorer's author-history boost read — and
 * refreshes per-account aggregates.
 */

const SYNC_INTERVAL_MS = 2 * 60 * 60 * 1000;   // every 2 hours
const BOOT_DELAY_MS = 15 * 60_000;             // let browser/session settle first
const RECHECK_AFTER_S = 6 * 3600;              // re-check a reply at most every 6h
const POSTED_WINDOW_S = 7 * 24 * 3600;         // stop tracking replies after a week
const MAX_PER_RUN = 10;                        // bound browser time per run

let _interval: NodeJS.Timeout | null = null;
let _bootTimer: NodeJS.Timeout | null = null;
let _running = false;

export function startReplyMetricsSync(): void {
  if (_interval) return;
  _bootTimer = setTimeout(() => { void runReplyMetricsSync('boot'); }, BOOT_DELAY_MS);
  _interval = setInterval(() => { void runReplyMetricsSync('interval'); }, SYNC_INTERVAL_MS);
  logger.info('Reply metrics sync scheduled', { everyHours: SYNC_INTERVAL_MS / 3_600_000 });
}

export function stopReplyMetricsSync(): void {
  if (_bootTimer) { clearTimeout(_bootTimer); _bootTimer = null; }
  if (_interval) { clearInterval(_interval); _interval = null; }
}

export async function runReplyMetricsSync(
  trigger: 'boot' | 'interval' | 'manual' = 'manual',
): Promise<{ synced: number; due: number }> {
  if (_running) return { synced: 0, due: 0 };
  if (!getBooleanSetting('system_running', true)) return { synced: 0, due: 0 };

  const due = getInteractionsNeedingMetricSync({
    olderThanSeconds: RECHECK_AFTER_S,
    postedWithinSeconds: POSTED_WINDOW_S,
    limit: MAX_PER_RUN,
  });
  if (due.length === 0) return { synced: 0, due: 0 };

  _running = true;
  logger.info('Reply metrics sync starting', { trigger, due: due.length });
  logEvent('REPLY_METRICS_SYNC_START', `${due.length} replies`);

  const touchedAccounts = new Set<string>();
  let synced = 0;
  try {
    for (const interaction of due) {
      const url = interaction.our_tweet_url
        ?? `https://x.com/i/web/status/${interaction.our_tweet_id}`;
      try {
        const data = await scrapeEngagement(url);
        updateInteractionMetrics(interaction.id, {
          likes: data.likes,
          replies: data.replies,
          retweets: data.retweets,
          impressions: data.impressions,
        });
        touchedAccounts.add(interaction.account_handle);
        synced++;
      } catch (err) {
        logger.warn('Reply metric scrape failed', { id: interaction.id, err: String(err) });
      }
      await delay(randomBetween(3000, 6000));
    }

    for (const handle of touchedAccounts) {
      refreshAccountReplyStats(handle);
    }

    logEvent('REPLY_METRICS_SYNC_COMPLETE', `synced ${synced}/${due.length}`);
    logger.info('Reply metrics sync complete', { synced, due: due.length });
    return { synced, due: due.length };
  } finally {
    _running = false;
  }
}
