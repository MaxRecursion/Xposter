import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DB_RELATIVE = 'data/test-scheduled-expiry.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

const YESTERDAY = '2026-08-30';
const TODAY = '2026-08-31';
// Well past both days' slots, so everything below is "due" by run_at alone.
const NOW = 1788200000;

describe('scheduled run day scoping', () => {
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

  it('does not return a previous day\'s unfired run as due', async () => {
    const runs = await import('../../src/storage/scheduled_runs.js');
    runs.insertScheduledRun(YESTERDAY, NOW - 86_400, 'ORIGINAL_POST', 'ORIGINAL');
    runs.insertScheduledRun(TODAY, NOW - 600, 'ORIGINAL_POST', 'ORIGINAL');

    // Unscoped: the stale row is still "due", which is the replay bug.
    expect(runs.getDuePendingRuns(NOW, 'ORIGINAL_POST')).toHaveLength(2);

    // Scoped to today: only today's slot fires.
    const due = runs.getDuePendingRuns(NOW, 'ORIGINAL_POST', TODAY);
    expect(due).toHaveLength(1);
    expect(due[0].run_date).toBe(TODAY);
  });

  it('expires prior-day scheduled runs and leaves today alone', async () => {
    const runs = await import('../../src/storage/scheduled_runs.js');
    runs.insertScheduledRun(YESTERDAY, NOW - 86_400, 'ORIGINAL_POST', 'ORIGINAL');
    runs.insertScheduledRun(YESTERDAY, NOW - 82_000, 'ORIGINAL_POST', 'QUOTE_TWEET');
    runs.insertScheduledRun(TODAY, NOW - 600, 'ORIGINAL_POST', 'ORIGINAL');

    expect(runs.expireStaleScheduledRuns(TODAY, 'ORIGINAL_POST')).toBe(2);

    const stale = runs.getScheduledRunsForDate(YESTERDAY, 'ORIGINAL_POST');
    expect(stale.map((r) => r.status)).toEqual(['SKIPPED', 'SKIPPED']);
    expect(stale[0].detail).toContain('expired: missed slot from 2026-08-30');
    // The original post type stays readable in the detail for later analytics.
    expect(stale[0].detail).toContain('ORIGINAL');

    const today = runs.getScheduledRunsForDate(TODAY, 'ORIGINAL_POST');
    expect(today.map((r) => r.status)).toEqual(['SCHEDULED']);
  });

  it('only expires the kind it is asked about', async () => {
    const runs = await import('../../src/storage/scheduled_runs.js');
    runs.insertScheduledRun(YESTERDAY, NOW - 86_400, 'ORIGINAL_POST', 'ORIGINAL');
    runs.insertScheduledRun(YESTERDAY, NOW - 86_400, 'PIPELINE', 'TIMELINE');

    expect(runs.expireStaleScheduledRuns(TODAY, 'ORIGINAL_POST')).toBe(1);
    expect(runs.getScheduledRunsForDate(YESTERDAY, 'PIPELINE')[0].status).toBe('SCHEDULED');
  });

  it('is a no-op when there is no backlog', async () => {
    const runs = await import('../../src/storage/scheduled_runs.js');
    runs.insertScheduledRun(TODAY, NOW - 600, 'PIPELINE', 'TIMELINE');
    expect(runs.expireStaleScheduledRuns(TODAY, 'PIPELINE')).toBe(0);
  });

  it('leaves already-resolved prior-day runs untouched', async () => {
    const runs = await import('../../src/storage/scheduled_runs.js');
    runs.insertScheduledRun(YESTERDAY, NOW - 86_400, 'PIPELINE', 'TIMELINE');
    const [row] = runs.getScheduledRunsForDate(YESTERDAY, 'PIPELINE');
    runs.markRunFired(row.id, 'TIMELINE');

    expect(runs.expireStaleScheduledRuns(TODAY, 'PIPELINE')).toBe(0);
    expect(runs.getScheduledRunsForDate(YESTERDAY, 'PIPELINE')[0].status).toBe('FIRED');
  });
});

describe('originals posted-today count', () => {
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

  it('counts only posts published since local midnight', async () => {
    const storage = await import('../../src/storage/original_posts.js');
    const { getDb } = await import('../../src/storage/db.js');
    const { startOfLocalDayUnix } = await import('../../src/utils/time.js');

    expect(storage.getOriginalsPostedTodayCount()).toBe(0);

    const today = storage.insertOriginalPost({
      content: 'Posted today.', language: 'english', topic: 'pune',
    });
    storage.markOriginalPostPosted(today.id, ['1'], ['https://x.com/a/status/1']);
    expect(storage.getOriginalsPostedTodayCount()).toBe(1);

    // A post from yesterday must not count against today's cap.
    const older = storage.insertOriginalPost({
      content: 'Posted yesterday.', language: 'english', topic: 'pune',
    });
    storage.markOriginalPostPosted(older.id, ['2'], ['https://x.com/a/status/2']);
    getDb()
      .prepare('UPDATE original_posts SET posted_at = ? WHERE id = ?')
      .run(startOfLocalDayUnix() - 3600, older.id);

    expect(storage.getOriginalsPostedTodayCount()).toBe(1);
  });

  it('ignores drafts that never reached POSTED', async () => {
    const storage = await import('../../src/storage/original_posts.js');
    const draft = storage.insertOriginalPost({
      content: 'Still generating.', language: 'english', topic: 'pune',
    });
    expect(storage.getOriginalsPostedTodayCount()).toBe(0);

    storage.markOriginalPostError(draft.id);
    expect(storage.getOriginalsPostedTodayCount()).toBe(0);
  });
});
