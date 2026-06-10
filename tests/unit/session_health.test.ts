import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DB_RELATIVE = 'data/test-session-health.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

describe('session health watchdog', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
  });

  afterEach(() => {
    vi.doUnmock('../../src/browser/session.js');
    vi.doUnmock('../../src/notifications/ntfy.js');
    delete process.env.DB_PATH_OVERRIDE;
    removeTestDb();
  });

  it('pauses once on logout and alerts only on the transition', async () => {
    const isLoggedIn = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    const sendSessionExpiredNotification = vi.fn().mockResolvedValue({ ok: true });

    vi.doMock('../../src/browser/session.js', () => ({ isLoggedIn }));
    vi.doMock('../../src/notifications/ntfy.js', () => ({ sendSessionExpiredNotification }));

    const { runSessionHealthCheck } = await import('../../src/scheduler/session_health.js');
    const { getSetting } = await import('../../src/storage/settings.js');

    expect(await runSessionHealthCheck()).toEqual({
      loggedIn: true,
      paused: false,
      alerted: false,
    });
    expect(await runSessionHealthCheck()).toEqual({
      loggedIn: false,
      paused: true,
      alerted: true,
    });
    expect(await runSessionHealthCheck()).toEqual({
      loggedIn: false,
      paused: false,
      alerted: false,
    });

    expect(getSetting('system_running', 'true')).toBe('false');
    expect(sendSessionExpiredNotification).toHaveBeenCalledTimes(1);
  });

  it('does not pause on a transient health-check exception', async () => {
    vi.doMock('../../src/browser/session.js', () => ({
      isLoggedIn: vi.fn().mockRejectedValue(new Error('browser unavailable')),
    }));
    const sendSessionExpiredNotification = vi.fn();
    vi.doMock('../../src/notifications/ntfy.js', () => ({ sendSessionExpiredNotification }));

    const { runSessionHealthCheck } = await import('../../src/scheduler/session_health.js');
    const { getSetting } = await import('../../src/storage/settings.js');

    expect(await runSessionHealthCheck()).toEqual({
      loggedIn: null,
      paused: false,
      alerted: false,
    });
    expect(getSetting('system_running', 'true')).toBe('true');
    expect(sendSessionExpiredNotification).not.toHaveBeenCalled();
  });
});
