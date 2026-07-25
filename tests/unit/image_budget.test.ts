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

describe('provider chain budget gating', () => {
  beforeEach(() => {
    vi.resetModules();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
    process.env.GEMINI_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.DB_PATH_OVERRIDE;
    delete process.env.GEMINI_API_KEY;
    delete process.env.IMAGE_PROVIDER;
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
});
