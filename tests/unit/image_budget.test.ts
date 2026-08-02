import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

const TEST_DB_RELATIVE = 'data/test-image-budget.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
}

describe('image budget guard', () => {
  beforeEach(() => {
    vi.resetModules();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
  });

  afterEach(() => {
    delete process.env.DB_PATH_OVERRIDE;
    removeTestDb();
  });

  it('starts at zero spend', async () => {
    const b = await import('../../src/storage/image_budget.js');
    expect(b.spendThisMonthUsd()).toBe(0);
    expect(b.generationsThisMonth()).toBe(0);
  });

  it('accumulates recorded spend', async () => {
    const b = await import('../../src/storage/image_budget.js');
    b.recordImageGeneration('gemini', 'gemini:gemini-3.1-flash-image', 0.067);
    b.recordImageGeneration('gemini', 'gemini:gemini-3.1-flash-image', 0.067);
    expect(b.spendThisMonthUsd()).toBeCloseTo(0.134, 5);
    expect(b.generationsThisMonth()).toBe(2);
  });

  it('counts QA retries, not just posted images', async () => {
    // The retries are what actually blow the budget — a guard that only counted
    // successful posts would undercount by the retry factor.
    const b = await import('../../src/storage/image_budget.js');
    for (let i = 0; i < 3; i++) b.recordImageGeneration('gemini', 'm', 0.067);
    expect(b.generationsThisMonth()).toBe(3);
    expect(b.spendThisMonthUsd()).toBeCloseTo(0.201, 5);
  });

  it('allows a paid call while under budget', async () => {
    const b = await import('../../src/storage/image_budget.js');
    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('image_monthly_budget_usd', '3.0');
    expect(b.canAffordImage(0.067)).toBe(true);
  });

  it('blocks a paid call that would exceed the budget', async () => {
    const b = await import('../../src/storage/image_budget.js');
    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('image_monthly_budget_usd', '0.20');
    for (let i = 0; i < 3; i++) b.recordImageGeneration('gemini', 'm', 0.067); // 0.201
    expect(b.canAffordImage(0.067)).toBe(false);
  });

  it('always allows free providers, even at zero budget', async () => {
    // Budget exhaustion must degrade to the free provider, not stop posting.
    const b = await import('../../src/storage/image_budget.js');
    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('image_monthly_budget_usd', '0');
    b.recordImageGeneration('gemini', 'm', 5);
    expect(b.canAffordImage(0)).toBe(true);
    expect(b.canAffordImage(0.067)).toBe(false);
  });

  it('ignores spend from previous months', async () => {
    const b = await import('../../src/storage/image_budget.js');
    const { getDb } = await import('../../src/storage/db.js');
    getDb().prepare(
      `INSERT INTO image_generations (provider, model, cost_usd, created_at) VALUES ('gemini','m',99,?)`,
    ).run(b.startOfMonth() - 86_400);
    expect(b.spendThisMonthUsd()).toBe(0);
    expect(b.canAffordImage(0.067)).toBe(true);
  });

  it('reports a status summary', async () => {
    const b = await import('../../src/storage/image_budget.js');
    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('image_monthly_budget_usd', '3.0');
    b.recordImageGeneration('gemini', 'm', 0.067);
    const s = b.budgetStatus();
    expect(s.budgetUsd).toBe(3);
    expect(s.spentUsd).toBeCloseTo(0.067, 3);
    expect(s.remainingUsd).toBeCloseTo(2.933, 3);
    expect(s.generations).toBe(1);
  });
});

/**
 * All of these pin `now`. Without that the assertions would flip depending on
 * which day of the month the suite happens to run.
 */
describe('pro-rata daily allowance', () => {
  const JUL_1 = new Date(2026, 6, 1, 12, 0, 0);
  const JUL_31 = new Date(2026, 6, 31, 12, 0, 0);

  beforeEach(() => {
    vi.resetModules();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
  });

  afterEach(() => {
    delete process.env.DB_PATH_OVERRIDE;
    removeTestDb();
  });

  async function seedToday(costUsd: number, times: number): Promise<void> {
    const b = await import('../../src/storage/image_budget.js');
    const { getDb } = await import('../../src/storage/db.js');
    const at = b.startOfDay(JUL_1) + 60;
    for (let i = 0; i < times; i++) {
      getDb().prepare(
        `INSERT INTO image_generations (provider, model, cost_usd, created_at) VALUES ('fal','m',?,?)`,
      ).run(costUsd, at);
    }
  }

  it('counts the days left in the month, including today', async () => {
    const b = await import('../../src/storage/image_budget.js');
    expect(b.daysRemainingInMonth(JUL_1)).toBe(31);
    expect(b.daysRemainingInMonth(JUL_31)).toBe(1);
    expect(b.daysRemainingInMonth(new Date(2026, 1, 28, 12))).toBe(1); // Feb, non-leap
  });

  it('ignores spend from earlier days when computing today', async () => {
    // Mid-month, so "yesterday" is still inside the same month — the point is
    // that the daily window is narrower than the monthly one.
    const JUL_15 = new Date(2026, 6, 15, 12, 0, 0);
    const b = await import('../../src/storage/image_budget.js');
    const { getDb } = await import('../../src/storage/db.js');
    getDb().prepare(
      `INSERT INTO image_generations (provider, model, cost_usd, created_at) VALUES ('fal','m',0.5,?)`,
    ).run(b.startOfDay(JUL_15) - 3600);

    expect(b.spendTodayUsd(JUL_15)).toBe(0);
    expect(b.spendThisMonthUsd(JUL_15)).toBeCloseTo(0.5, 5);
  });

  it('blocks the third paid attempt of the day while the month is barely touched', async () => {
    const b = await import('../../src/storage/image_budget.js');
    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('image_monthly_budget_usd', '3.0');
    setSetting('image_daily_burst', '2.0');

    expect(b.canAffordImage(0.08, JUL_1)).toBe(true);

    await seedToday(0.08, 2);
    // Monthly spend is only $0.16 of $3 — it is the DAILY rule that binds,
    // which is what keeps one good image landing every evening all month.
    expect(b.spendThisMonthUsd(JUL_1)).toBeCloseTo(0.16, 5);
    expect(b.canAffordImage(0.08, JUL_1)).toBe(false);
  });

  it('never gates free providers, even once the daily allowance is gone', async () => {
    const b = await import('../../src/storage/image_budget.js');
    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('image_monthly_budget_usd', '3.0');
    await seedToday(0.08, 5);
    expect(b.canAffordImage(0, JUL_1)).toBe(true);
  });

  it('widens the allowance when earlier days underspent', async () => {
    const b = await import('../../src/storage/image_budget.js');
    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('image_monthly_budget_usd', '3.0');
    setSetting('image_daily_burst', '2.0');

    const early = b.dailyAllowanceUsd(JUL_1);            // 3/31*2
    const late = b.dailyAllowanceUsd(new Date(2026, 6, 20, 12)); // 3/12*2
    expect(late).toBeGreaterThan(early);
  });

  it('lets a high burst effectively disable the daily rule, monthly cap still binding', async () => {
    const b = await import('../../src/storage/image_budget.js');
    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('image_monthly_budget_usd', '3.0');
    setSetting('image_daily_burst', '31');
    await seedToday(0.08, 5);
    expect(b.canAffordImage(0.08, JUL_1)).toBe(true);

    setSetting('image_monthly_budget_usd', '0.45');
    expect(b.canAffordImage(0.08, JUL_1)).toBe(false);
  });

  it('reports today and the allowance in the status summary', async () => {
    const b = await import('../../src/storage/image_budget.js');
    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('image_monthly_budget_usd', '3.0');
    setSetting('image_daily_burst', '2.0');
    await seedToday(0.08, 1);

    const s = b.budgetStatus(JUL_1);
    expect(s.spentTodayUsd).toBeCloseTo(0.08, 3);
    expect(s.daysRemaining).toBe(31);
    expect(s.dailyAllowanceUsd).toBeCloseTo(((3 - 0.08) / 31) * 2, 3);
  });
});

describe('provider chain budget gating', () => {
  beforeEach(() => {
    vi.resetModules();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
    process.env.GEMINI_API_KEY = 'test-key';
    // Hermeticity: fal now precedes gemini in the chain, so a FAL_KEY exported
    // in the developer's shell would otherwise flip every ordering assertion.
    delete process.env.FAL_KEY;
  });

  afterEach(() => {
    delete process.env.DB_PATH_OVERRIDE;
    delete process.env.GEMINI_API_KEY;
    delete process.env.IMAGE_PROVIDER;
    delete process.env.FAL_KEY;
    removeTestDb();
  });

  it('puts the paid provider first when affordable', async () => {
    const { buildImageProviders } = await import('../../src/images/providers/index.js');
    const names = buildImageProviders().map((p) => p.name);
    expect(names[0]).toBe('gemini');
    expect(names).toContain('pollinations');
  });

  it('drops the paid provider once the budget is spent, keeping the free one', async () => {
    const b = await import('../../src/storage/image_budget.js');
    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('image_monthly_budget_usd', '0.10');
    b.recordImageGeneration('gemini', 'm', 0.09);

    const { buildImageProviders } = await import('../../src/images/providers/index.js');
    const names = buildImageProviders().map((p) => p.name);
    expect(names).not.toContain('gemini');
    expect(names).toContain('pollinations');
  });

  it('leads with fal when its key is present', async () => {
    // fal has no minimum spend and no expiring credits, so it must outrank a
    // Gemini key whose project may not even have billing enabled.
    process.env.FAL_KEY = 'test-fal-key';
    const { buildImageProviders } = await import('../../src/images/providers/index.js');
    const names = buildImageProviders().map((p) => p.name);
    expect(names[0]).toBe('fal');
    expect(names[1]).toBe('gemini');
  });

  it('drops fal when the budget is exhausted, keeping the free provider', async () => {
    process.env.FAL_KEY = 'test-fal-key';
    const b = await import('../../src/storage/image_budget.js');
    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('image_monthly_budget_usd', '0.05');
    b.recordImageGeneration('fal', 'm', 0.04);

    const { buildImageProviders } = await import('../../src/images/providers/index.js');
    const names = buildImageProviders().map((p) => p.name);
    expect(names).not.toContain('fal');
    expect(names).toContain('pollinations');
  });

  it('honours IMAGE_PROVIDER as a manual pin', async () => {
    process.env.FAL_KEY = 'test-fal-key';
    process.env.IMAGE_PROVIDER = 'gemini';
    const { buildImageProviders } = await import('../../src/images/providers/index.js');
    expect(buildImageProviders().map((p) => p.name)[0]).toBe('gemini');
  });
});
