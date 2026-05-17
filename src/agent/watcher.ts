import {
  isAgentEnabled, isClaudeCliFound, getWatchIntervalMs, getErrorThreshold, getMaxRunsPerDay,
} from './client.js';
import { errorSignature } from './signature.js';
import {
  getActivityRowsSince, upsertInvestigation, findOpenInvestigationBySignature,
  getRunCountToday,
} from './store.js';
import { runInvestigation } from './investigator.js';
import { getSetting, setSetting, logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import type { ActivityRow } from './types.js';

/**
 * Watches the activity_log for recurring errors and triggers investigator runs.
 *
 * Matches the start/stop module shape of src/scheduler/audience_sync.ts.
 * Boot delay 60s; default tick interval 5 minutes; configurable.
 *
 * For each tick:
 *   1. Pull rows since `agent_last_watched_at` whose event is in the allowlist.
 *   2. Group by error signature.
 *   3. For each signature with occurrences ≥ threshold AND no open investigation:
 *      upsert investigation, kick an async investigation run (fire-and-forget).
 *   4. Update `agent_last_watched_at`.
 */

const WATCHED_EVENTS = [
  'PIPELINE_ERROR',
  'CANDIDATE_ERROR',
  'POST_ERROR',
  'NOTIFICATION_FAILED',
  'FOLLOWER_SYNC_ERROR',
  'DELETE_ERROR',
  'AUDIENCE_SYNC_FAILED',
  'AUDIENCE_SYNC_ERROR',
  'ORIGINAL_POST_ERROR',
];

const BOOT_DELAY_MS = 60_000;

let _interval: NodeJS.Timeout | null = null;
let _bootTimer: NodeJS.Timeout | null = null;
let _running = false;
let _unavailableLogged = false;

export function startAgentWatcher(): void {
  if (_interval) return;
  if (!isAgentEnabled()) {
    logger.info('Agent watcher not started: agent disabled');
    return;
  }
  if (!isClaudeCliFound()) {
    if (!_unavailableLogged) {
      logger.warn('Agent watcher not started: `claude` CLI not found on PATH');
      logEvent('AGENT_DISABLED_UNAVAILABLE', 'claude CLI not found');
      _unavailableLogged = true;
    }
    return;
  }

  _bootTimer = setTimeout(() => { void runAgentWatcherTick('boot'); }, BOOT_DELAY_MS);
  _interval = setInterval(() => { void runAgentWatcherTick('interval'); }, getWatchIntervalMs());
  logger.info('Agent watcher started', { intervalMs: getWatchIntervalMs() });
}

export function stopAgentWatcher(): void {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_bootTimer) { clearTimeout(_bootTimer); _bootTimer = null; }
}

export async function runAgentWatcherTick(
  trigger: 'boot' | 'interval' | 'manual',
): Promise<{ investigated: number; skipped: number }> {
  if (_running) return { investigated: 0, skipped: 0 };
  // Re-check gates each tick — settings may have been toggled off
  if (!isAgentEnabled()) return { investigated: 0, skipped: 0 };
  if (!isClaudeCliFound()) return { investigated: 0, skipped: 0 };

  _running = true;
  try {
    const sinceStr = getSetting('agent_last_watched_at', '0');
    const since = Math.max(parseInt(sinceStr, 10) || 0, Math.floor(Date.now() / 1000) - 24 * 3600);

    const rows = getActivityRowsSince(since, WATCHED_EVENTS);
    if (rows.length === 0) {
      setSetting('agent_last_watched_at', String(Math.floor(Date.now() / 1000)));
      return { investigated: 0, skipped: 0 };
    }

    // Group by signature
    const groups = new Map<string, ActivityRow[]>();
    for (const r of rows) {
      const sig = errorSignature(r.event, r.detail);
      const arr = groups.get(sig) ?? [];
      arr.push(r);
      groups.set(sig, arr);
    }

    const threshold = getErrorThreshold();
    const cap = getMaxRunsPerDay();

    let investigated = 0;
    let skipped = 0;

    for (const [sig, cluster] of groups) {
      // Cheap occurrence-count check first
      if (cluster.length < threshold) { skipped++; continue; }

      // Skip if there's already an open / proposed investigation for this sig
      const existing = findOpenInvestigationBySignature(sig);
      const haveOpen = existing && (existing.status === 'OPEN' || existing.status === 'PROPOSED');

      // Always upsert so occurrences count keeps incrementing across ticks
      const sample = cluster[cluster.length - 1];
      upsertInvestigation({
        signature: sig,
        eventName: sample.event,
        sampleDetail: sample.detail,
        occurredAt: sample.created_at,
      });

      if (haveOpen) { skipped++; continue; }
      if (getRunCountToday() >= cap) {
        skipped++;
        logEvent('AGENT_WATCHER_CAP_REACHED', `cap=${cap} sig=${sig}`);
        continue;
      }

      // Kick the investigation; deliberately do NOT await — we want the
      // watcher tick to return quickly.
      void runInvestigation({ errors: cluster, trigger: 'watcher' })
        .catch((err) => {
          logger.error('Watcher-triggered investigation threw', { sig, err: String(err) });
          logEvent('AGENT_INVESTIGATION_ERROR', String(err));
        });
      investigated++;
    }

    setSetting('agent_last_watched_at', String(Math.floor(Date.now() / 1000)));
    logEvent('AGENT_WATCH_TICK', `trigger=${trigger} investigated=${investigated} skipped=${skipped}`);
    return { investigated, skipped };
  } finally {
    _running = false;
  }
}
