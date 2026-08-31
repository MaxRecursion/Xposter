import {
  expireStaleScheduledRuns, getDuePendingRuns, getScheduledRunsForDate, getUpcomingRuns,
  insertScheduledRun, markRunError, markRunFired, ScheduledRun,
} from '../storage/scheduled_runs.js';
import { logEvent, type PostSource } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { formatLocalTime, generateWeightedSlots, todayDateKey } from './daily_plan.js';
import { getIntSetting } from '../storage/settings.js';
import { getBooleanSetting } from '../storage/settings.js';

/**
 * Randomized daily reply scheduler.
 *
 * Strategy:
 *   - At boot (and every midnight), generate today's run plan: N random
 *     timestamps within the active window (default 09:00–22:00 IST), with a
 *     minimum spacing between runs.
 *   - Each slot is also assigned a SOURCE (trend-global / trend-india /
 *     timeline), stored in `scheduled_runs.detail`.
 *   - A 60-second tick checks for due, unfired SCHEDULED rows and fires them.
 *   - Already-passed times today are NOT scheduled (avoid retroactive firing on boot).
 *
 * The mix lives here rather than in a second scheduler because the pipeline's
 * single-flight guard is a module-level flag inside reply_pipeline.ts — a
 * separate scheduler would sit outside it and could drive two Playwright
 * sessions at once.
 */

let _tickHandle: NodeJS.Timeout | null = null;
let _onFire: (source: PostSource) => Promise<void> = async () => {};

const TICK_INTERVAL_MS = 60_000;

export function configureRandomRuns(onFire: (source: PostSource) => Promise<void>): void {
  _onFire = onFire;
}

export function startRandomScheduler(): void {
  ensureTodayPlan();
  if (_tickHandle) return;
  _tickHandle = setInterval(tick, TICK_INTERVAL_MS);
  // Tick once immediately so any due runs from this boot fire promptly
  void tick();
}

export function stopRandomScheduler(): void {
  if (_tickHandle) {
    clearInterval(_tickHandle);
    _tickHandle = null;
  }
}

/** Ensures we have a plan row for today; called at boot and once per tick. */
export function ensureTodayPlan(): ScheduledRun[] {
  const dateKey = todayDateKey();

  // Slots missed while the app was down are closed out rather than left due,
  // so a restart cannot replay yesterday's runs on top of today's plan.
  const expired = expireStaleScheduledRuns(dateKey, 'PIPELINE');
  if (expired > 0) {
    logEvent('SCHEDULE_RUNS_EXPIRED', `${expired} missed run(s) from earlier days`);
    logger.info('Expired missed pipeline runs', { count: expired, before: dateKey });
  }

  const existing = getScheduledRunsForDate(dateKey);
  if (existing.length > 0) return existing;

  const plan = generateRandomTimes(dateKey);
  const sources = allocateSources(plan.length);
  for (let i = 0; i < plan.length; i++) {
    insertScheduledRun(dateKey, plan[i], 'PIPELINE', sources[i]);
  }
  const created = getScheduledRunsForDate(dateKey);
  const mix = summarizeMix(created);
  logEvent(
    'SCHEDULE_PLAN_CREATED',
    `${created.length} runs (${mix}) at: ${created.map((r) => formatLocalTime(r.run_at)).join(', ')}`,
  );
  logger.info('Today\'s random run plan created', {
    date: dateKey,
    mix,
    times: created.map((r) => formatLocalTime(r.run_at)),
  });
  return created;
}

/**
 * Splits the day's runs across sources.
 *
 * Computed exactly and up front rather than rolled per run: a per-run coin flip
 * would let a day land at 9/1 global/India by chance, and the whole point of
 * the 50/50 split is that it holds. Shuffling afterwards keeps the sources
 * interleaved through the day instead of clumping all the trend runs together.
 */
export function allocateSources(total: number): PostSource[] {
  if (total <= 0) return [];

  const trendEnabled = getBooleanSetting('trend_replies_enabled', true);
  const trendPct = trendEnabled ? getIntSetting('trend_reply_ratio', 70, 0, 100) : 0;
  const globalPct = getIntSetting('trend_global_ratio', 50, 0, 100);

  const trendCount = Math.round(total * trendPct / 100);
  const globalCount = Math.round(trendCount * globalPct / 100);

  const sources: PostSource[] = [
    ...Array<PostSource>(globalCount).fill('TREND_GLOBAL'),
    ...Array<PostSource>(trendCount - globalCount).fill('TREND_INDIA'),
    ...Array<PostSource>(total - trendCount).fill('TIMELINE'),
  ];

  // Fisher-Yates, same as the original-post scheduler's type assignment.
  for (let i = sources.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sources[i], sources[j]] = [sources[j], sources[i]];
  }
  return sources;
}

function summarizeMix(runs: ScheduledRun[]): string {
  const counts = countBySource(runs);
  return Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ');
}

/** Per-source run counts for today, so the planned mix is visible in the API. */
export function getTodayMix(): Record<PostSource, number> {
  return countBySource(getScheduledRunsForDate(todayDateKey()));
}

function countBySource(runs: ScheduledRun[]): Record<PostSource, number> {
  const counts: Record<PostSource, number> = { TIMELINE: 0, TREND_GLOBAL: 0, TREND_INDIA: 0 };
  for (const r of runs) counts[parseSource(r.detail)]++;
  return counts;
}

const VALID_SOURCES: PostSource[] = ['TIMELINE', 'TREND_GLOBAL', 'TREND_INDIA'];

function parseSource(detail: string | null): PostSource {
  return VALID_SOURCES.includes(detail as PostSource) ? (detail as PostSource) : 'TIMELINE';
}

export function getTodayPlan(): ScheduledRun[] {
  return getScheduledRunsForDate(todayDateKey());
}

export function getNextRuns(limit = 5): ScheduledRun[] {
  return getUpcomingRuns(Math.floor(Date.now() / 1000), limit);
}

/**
 * Returns N random unix-second timestamps inside the active window for the given
 * date (local), enforcing a minimum spacing.
 */
function generateRandomTimes(dateKey: string): number[] {
  const n = getIntSetting('random_runs_per_day', 20, 1, 30);
  return generateWeightedSlots(n, dateKey);
}

async function tick(): Promise<void> {
  // Maybe roll into a new day
  ensureTodayPlan();
  if (!getBooleanSetting('system_running', true)) return;

  const due = getDuePendingRuns(Math.floor(Date.now() / 1000), 'PIPELINE', todayDateKey());
  if (due.length === 0) return;

  // Fire only the oldest due run; remaining will fire on next tick.
  const next = due[0];
  // Read the source BEFORE marking fired: markRunFired writes
  // `detail = COALESCE(?, detail)`, so passing any string here would overwrite
  // the source label we stored at plan time.
  const source = parseSource(next.detail);
  markRunFired(next.id);

  logEvent('SCHEDULED_RUN_FIRED', `id=${next.id} source=${source} time=${formatLocalTime(next.run_at)}`);
  logger.info('Firing scheduled pipeline run', { id: next.id, source, runAt: formatLocalTime(next.run_at) });

  try {
    await _onFire(source);
  } catch (err) {
    // Keep FIRED (slot consumed) but record ERROR detail so the dashboard
    // shows the loss — reply pipeline has its own single-flight guard and
    // timeline fall-through, so an immediate reschedule would often pile on.
    const msg = String(err).slice(0, 300);
    markRunError(next.id, `source=${source}; ${msg}`);
    logger.error('Scheduled run handler threw', { err: msg });
    logEvent('SCHEDULED_RUN_ERROR', `id=${next.id} source=${source} err=${msg}`);
  }
}
