/**
 * Spend ledger and budget guard for paid image generation.
 *
 * Every paid call is recorded here — including QA-gate retries, which is the
 * whole point: an autonomous daemon that regenerates on rejection is exactly
 * how a $2.40/month budget quietly becomes $40. Counting only posted images
 * would miss the retries that actually cost the money.
 *
 * Two rules gate a paid call:
 *   1. A hard monthly ceiling.
 *   2. A pro-rata DAILY allowance, derived from what's left and how many days
 *      remain. The monthly cap alone is solvent but not smooth — it lets the
 *      budget burn out around day 20, after which every evening silently
 *      degrades to the free provider and mostly fails QA, so the post just
 *      stops appearing. Spreading the spend keeps one good image per day
 *      landing all month.
 *
 * When either rule blocks, the paid provider is dropped from the chain and
 * generation falls through to the free one — posting degrades, never halts.
 */
import { getDb } from './db.js';
import { getFloatSetting } from './settings.js';
import { logger } from '../utils/logger.js';

/**
 * `now` is injectable throughout so tests are deterministic. Without it, every
 * allowance assertion would flip depending on which day of the month the suite
 * happens to run.
 */

/** Unix seconds at the start of the current local calendar month. */
export function startOfMonth(now: Date = new Date()): number {
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0).getTime() / 1000);
}

/** Unix seconds at local midnight today. */
export function startOfDay(now: Date = new Date()): number {
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).getTime() / 1000);
}

/** Days left in the month, counting today. Never below 1. */
export function daysRemainingInMonth(now: Date = new Date()): number {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Math.max(1, daysInMonth - now.getDate() + 1);
}

export function recordImageGeneration(provider: string, model: string, costUsd: number): void {
  try {
    getDb().prepare(`
      INSERT INTO image_generations (provider, model, cost_usd) VALUES (?, ?, ?)
    `).run(provider, model, costUsd);
  } catch (err) {
    // Never let bookkeeping break generation.
    logger.warn('Failed to record image generation cost', { err: String(err).slice(0, 200) });
  }
}

function sumSince(sinceUnix: number): number {
  try {
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS total FROM image_generations WHERE created_at >= ?
    `).get(sinceUnix) as { total: number };
    return row.total;
  } catch {
    return 0;
  }
}

export function spendThisMonthUsd(now: Date = new Date()): number {
  return sumSince(startOfMonth(now));
}

export function spendTodayUsd(now: Date = new Date()): number {
  return sumSince(startOfDay(now));
}

export function generationsThisMonth(now: Date = new Date()): number {
  try {
    const row = getDb().prepare(`
      SELECT COUNT(*) AS n FROM image_generations WHERE created_at >= ?
    `).get(startOfMonth(now)) as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

export function monthlyBudgetUsd(): number {
  return getFloatSetting('image_monthly_budget_usd', 3.0, 0, 100);
}

/**
 * How much of a day's headroom may be spent at once.
 *
 * 1.0 would spread spend perfectly evenly but allow only a single paid attempt
 * on most days, so one QA rejection would end the evening. 2.0 permits a retry
 * while still finishing the month.
 */
export function dailyBurst(): number {
  return getFloatSetting('image_daily_burst', 2.0, 1, 31);
}

/**
 * Today's spending allowance, recomputed from what's actually left.
 *
 * Self-correcting: underspending widens tomorrow's allowance, overspending
 * narrows it, and the monthly ceiling still binds absolutely.
 */
export function dailyAllowanceUsd(now: Date = new Date()): number {
  const remaining = Math.max(0, monthlyBudgetUsd() - spendThisMonthUsd(now));
  return (remaining / daysRemainingInMonth(now)) * dailyBurst();
}

/**
 * Whether one more call at `costUsd` is affordable right now.
 *
 * Free providers (cost 0) always pass — the budget exists to bound spend, not
 * to stop the bot posting.
 */
export function canAffordImage(costUsd: number, now: Date = new Date()): boolean {
  if (costUsd <= 0) return true;

  const budget = monthlyBudgetUsd();
  if (budget <= 0) return false;
  if (spendThisMonthUsd(now) + costUsd > budget) return false;

  return spendTodayUsd(now) + costUsd <= dailyAllowanceUsd(now);
}

export function budgetStatus(now: Date = new Date()): {
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
  generations: number;
  spentTodayUsd: number;
  dailyAllowanceUsd: number;
  daysRemaining: number;
} {
  const spentUsd = spendThisMonthUsd(now);
  const budgetUsd = monthlyBudgetUsd();
  const round = (n: number) => Math.round(n * 1000) / 1000;

  return {
    spentUsd: round(spentUsd),
    budgetUsd,
    remainingUsd: round(Math.max(0, budgetUsd - spentUsd)),
    generations: generationsThisMonth(now),
    spentTodayUsd: round(spendTodayUsd(now)),
    dailyAllowanceUsd: round(dailyAllowanceUsd(now)),
    daysRemaining: daysRemainingInMonth(now),
  };
}
