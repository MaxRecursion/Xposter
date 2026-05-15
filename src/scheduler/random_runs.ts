import {
  getDuePendingRuns, getScheduledRunsForDate, getUpcomingRuns,
  insertScheduledRun, markRunFired, ScheduledRun,
} from '../storage/accounts.js';
import { getSetting, logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { pickWeightedOffsetMinute } from './audience_weights.js';

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
    `${created.length} runs at: ${created.map((r) => formatTimeIST(r.run_at)).join(', ')}`,
  );
  logger.info('Today\'s random run plan created', {
    date: dateKey,
    times: created.map((r) => formatTimeIST(r.run_at)),
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
  const n = clampInt(getSetting('random_runs_per_day', '5'), 1, 12);
  const startHour = clampInt(getSetting('active_window_start_hour', '9'), 0, 23);
  const endHourRaw = clampInt(getSetting('active_window_end_hour', '22'), 1, 24);
  const endHour = endHourRaw <= startHour ? startHour + 1 : endHourRaw;

  const [y, m, d] = dateKey.split('-').map(Number);
  const startMs = new Date(y, m - 1, d, startHour, 0, 0).getTime();
  const endMs   = new Date(y, m - 1, d, endHour, 0, 0).getTime();

  const totalMinutes = Math.floor((endMs - startMs) / 60_000);
  if (totalMinutes <= 0) return [];

  // Jittered grid: divide window into N equal slots, pick one time per slot
  // weighted by the audience-engagement heatmap (falls back to uniform when
  // no heatmap is available). Min-spacing is preserved by the slot boundaries.
  const slotMin = Math.floor(totalMinutes / n);
  const picks: number[] = [];
  for (let i = 0; i < n; i++) {
    const slotStart = i * slotMin;
    const slotEnd = (i + 1) * slotMin;
    const offsetMin = pickWeightedOffsetMinute(startMs, slotStart, slotEnd);
    const ts = Math.floor((startMs + offsetMin * 60_000) / 1000);

    // Drop already-passed times for today — don't backfill on boot
    if (ts > Math.floor(Date.now() / 1000) + 60) {
      picks.push(ts);
    }
  }
  return picks;
}

async function tick(): Promise<void> {
  // Maybe roll into a new day
  ensureTodayPlan();

  const due = getDuePendingRuns(Math.floor(Date.now() / 1000));
  if (due.length === 0) return;

  // Fire only the oldest due run; remaining will fire on next tick.
  const next = due[0];
  markRunFired(next.id, 'fired by random scheduler');
  logEvent('SCHEDULED_RUN_FIRED', `id=${next.id} time=${formatTimeIST(next.run_at)}`);
  logger.info('Firing scheduled pipeline run', { id: next.id, runAt: formatTimeIST(next.run_at) });

  try {
    await _onFire();
  } catch (err) {
    logger.error('Scheduled run handler threw', { err: String(err) });
  }
}

function todayDateKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTimeIST(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function clampInt(value: string, min: number, max: number): number {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
