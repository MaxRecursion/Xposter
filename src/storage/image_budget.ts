/**
 * Spend ledger for paid image generation.
 *
 * Every paid call is recorded here — including QA-gate retries, which is the
 * whole point: an autonomous daemon that regenerates on rejection is exactly
 * how a $2.40/month budget quietly becomes $40. Counting only posted images
 * would miss the retries that actually cost the money.
 *
 * When the budget is exhausted the paid provider is skipped and the chain
 * falls through to the free one, so posting degrades rather than stopping.
 */
import { getDb } from './db.js';
import { getFloatSetting } from './settings.js';
import { logger } from '../utils/logger.js';

/** Unix seconds at the start of the current local calendar month. */
export function startOfMonth(): number {
  const d = new Date();
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0).getTime() / 1000);
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

export function spendThisMonthUsd(): number {
  try {
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS total FROM image_generations WHERE created_at >= ?
    `).get(startOfMonth()) as { total: number };
    return row.total;
  } catch {
    return 0;
  }
}

export function generationsThisMonth(): number {
  try {
    const row = getDb().prepare(`
      SELECT COUNT(*) AS n FROM image_generations WHERE created_at >= ?
    `).get(startOfMonth()) as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

export function monthlyBudgetUsd(): number {
  return getFloatSetting('image_monthly_budget_usd', 3.0, 0, 100);
}

/**
 * Whether one more call at `costUsd` fits in this month's budget.
 *
 * Free providers (cost 0) always pass — the budget exists to bound spend, not
 * to stop the bot posting.
 */
export function canAffordImage(costUsd: number): boolean {
  if (costUsd <= 0) return true;
  const budget = monthlyBudgetUsd();
  if (budget <= 0) return false;
  return spendThisMonthUsd() + costUsd <= budget;
}

export function budgetStatus(): {
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
  generations: number;
} {
  const spentUsd = spendThisMonthUsd();
  const budgetUsd = monthlyBudgetUsd();
  return {
    spentUsd: Math.round(spentUsd * 1000) / 1000,
    budgetUsd,
    remainingUsd: Math.round(Math.max(0, budgetUsd - spentUsd) * 1000) / 1000,
    generations: generationsThisMonth(),
  };
}
