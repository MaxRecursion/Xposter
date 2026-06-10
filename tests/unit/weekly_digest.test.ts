import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DB_RELATIVE = 'data/test-weekly-digest.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

describe('weekly digest scheduler', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
  });

  afterEach(() => {
    vi.doUnmock('../../src/notifications/ntfy.js');
    delete process.env.DB_PATH_OVERRIDE;
    removeTestDb();
  });

  it('sends once on Sunday after the configured hour', async () => {
    const sendWeeklyDigestNotification = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock('../../src/notifications/ntfy.js', () => ({ sendWeeklyDigestNotification }));

    const { runWeeklyDigest } = await import('../../src/scheduler/weekly_digest.js');
    const sunday = new Date(2026, 5, 14, 10, 0, 0);

    expect(await runWeeklyDigest('scheduled', sunday)).toEqual({ sent: true });
    expect(await runWeeklyDigest('scheduled', sunday)).toEqual({
      sent: false,
      skipped: 'already sent this week',
    });
    expect(sendWeeklyDigestNotification).toHaveBeenCalledTimes(1);
  });

  it('does not send before Sunday', async () => {
    const sendWeeklyDigestNotification = vi.fn();
    vi.doMock('../../src/notifications/ntfy.js', () => ({ sendWeeklyDigestNotification }));

    const { runWeeklyDigest } = await import('../../src/scheduler/weekly_digest.js');
    const saturday = new Date(2026, 5, 13, 12, 0, 0);

    expect(await runWeeklyDigest('scheduled', saturday)).toEqual({
      sent: false,
      skipped: 'not due',
    });
    expect(sendWeeklyDigestNotification).not.toHaveBeenCalled();
  });
});
