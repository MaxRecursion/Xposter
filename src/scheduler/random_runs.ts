import {
  getDuePendingRuns, getScheduledRunsForDate, getUpcomingRuns,
  insertScheduledRun, markRunFired, ScheduledRun,
} from '../storage/scheduled_runs.js';
import { logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { formatLocalTime, generateWeightedSlots, todayDateKey } from './daily_plan.js';
import { getIntSetting } from '../storage/settings.js';
import { getBooleanSetting } from '../storage/settings.js';

/**
 * Randomized 5x-daily scheduler.
 *
 * Strategy:
 *   - At boot (and every midnight), generate today's run plan: N random
 *     timestamps within the active window (default 09:00–22:00 IST), with a
 *     minimum spacing between runs.
 *   - A 60-second tick checks for due, unfired SCHEDULED rows and fires them.
 *   - Already-passed times today are NOT scheduled (avoid retroactive firing on boot).
 */

let _tickHandle: NodeJS.Timeout | null = null;
let _onFire: () => Promise<void> = async () => {};

const TICK_INTERVAL_MS = 60_000;

export function configureRandomRuns(onFire: () => Promise<void>): void {
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
  const existing = getScheduledRunsForDate(dateKey);
  if (existing.length > 0) return existing;

  const plan = generateRandomTimes(dateKey);
  for (const ts of plan) {
    insertScheduledRun(dateKey, ts);
  }
  const created = getScheduledRunsForDate(dateKey);
  logEvent(
    'SCHEDULE_PLAN_CREATED',
    `${created.length} runs at: ${created.map((r) => formatLocalTime(r.run_at)).join(', ')}`,
  );
  logger.info('Today\'s random run plan created', {
    date: dateKey,
    times: created.map((r) => formatLocalTime(r.run_at)),
  });
  return created;
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

  const due = getDuePendingRuns(Math.floor(Date.now() / 1000));
  if (due.length === 0) return;

  // Fire only the oldest due run; remaining will fire on next tick.
  const next = due[0];
  markRunFired(next.id, 'fired by random scheduler');
  logEvent('SCHEDULED_RUN_FIRED', `id=${next.id} time=${formatLocalTime(next.run_at)}`);
  logger.info('Firing scheduled pipeline run', { id: next.id, runAt: formatLocalTime(next.run_at) });

  try {
    await _onFire();
  } catch (err) {
    logger.error('Scheduled run handler threw', { err: String(err) });
  }
}
