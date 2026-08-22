import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

const TEST_DB_RELATIVE = 'data/test-follower-sync.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

function mockAccount(handle: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    handle,
    display_name: handle,
    bio: null,
    bio_fetched_at: null,
    classification: 'REGULAR',
    classification_confidence: 0.8,
    classification_reasoning: 'mocked',
    classified_at: now,
    classification_model: 'mock',
    is_marathi_creator: 0,
    verified: 0,
    follower_count_seen: 123,
    following_count_seen: 50,
    followed_by_us: 0,
    following_us: 1,
    mutual_follow: 0,
    blocked_or_muted: 0,
    total_replies_sent: 0,
    total_engagement: 0,
    avg_reply_score: 0,
    successful_replies: 0,
    author_engaged_replies: 0,
    first_seen_at: now,
    last_seen_at: now,
    updated_at: now,
  };
}

describe('runFollowerSync', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
  });

  afterEach(() => {
    vi.doUnmock('../../src/browser/followers.js');
    vi.doUnmock('../../src/pipeline/classifier.js');
    vi.doUnmock('../../src/notifications/ntfy.js');
    delete process.env.DB_PATH_OVERRIDE;
    removeTestDb();
  });

  it('queues pending follow-back events for newly detected followers', async () => {
    const sendFollowerNotification = vi.fn().mockResolvedValue({ ok: true });

    vi.doMock('../../src/browser/followers.js', () => ({
      resolveOwnHandle: vi.fn().mockResolvedValue('my_handle'),
      fetchOurFollowerEntries: vi.fn().mockResolvedValue([
        { handle: 'new_follower', followedByUs: false },
      ]),
      fetchOurFollowers: vi.fn(),
      followBack: vi.fn(),
    }));
    vi.doMock('../../src/pipeline/classifier.js', () => ({
      classifyAccount: vi.fn().mockImplementation((handle: string) => Promise.resolve(mockAccount(handle))),
    }));
    vi.doMock('../../src/notifications/ntfy.js', () => ({
      sendFollowerNotification,
      sendUnfollowNotification: vi.fn().mockResolvedValue({ ok: true }),
    }));

    const { runFollowerSync } = await import('../../src/scheduler/follower_sync.js');
    const { listFollowerEvents } = await import('../../src/storage/follower_events.js');
    const { getAccount } = await import('../../src/storage/accounts.js');

    const result = await runFollowerSync();

    expect(result).toMatchObject({
      ok: true,
      handle: 'my_handle',
      total: 1,
      newFollowers: 1,
      queued: 1,
    });

    const events = listFollowerEvents('PENDING');
    expect(events).toHaveLength(1);
    expect(events[0].account_handle).toBe('new_follower');
    expect(events[0].detail).toContain('relationship=not_followed_back');
    expect(getAccount('new_follower')?.following_us).toBe(1);
    expect(getAccount('new_follower')?.followed_by_us).toBe(0);
    expect(sendFollowerNotification).toHaveBeenCalledTimes(1);
  });

  it('does not queue followers that are already followed back', async () => {
    vi.doMock('../../src/browser/followers.js', () => ({
      resolveOwnHandle: vi.fn().mockResolvedValue('my_handle'),
      fetchOurFollowerEntries: vi.fn().mockResolvedValue([
        { handle: 'mutual_friend', followedByUs: true },
      ]),
      fetchOurFollowers: vi.fn(),
      followBack: vi.fn(),
    }));
    vi.doMock('../../src/pipeline/classifier.js', () => ({
      classifyAccount: vi.fn().mockImplementation((handle: string) => Promise.resolve(mockAccount(handle))),
    }));
    vi.doMock('../../src/notifications/ntfy.js', () => ({
      sendFollowerNotification: vi.fn(),
      sendUnfollowNotification: vi.fn().mockResolvedValue({ ok: true }),
    }));

    const { runFollowerSync } = await import('../../src/scheduler/follower_sync.js');
    const { listPendingFollowBackEvents } = await import('../../src/storage/follower_events.js');
    const { getAccount } = await import('../../src/storage/accounts.js');

    const result = await runFollowerSync();

    expect(result).toMatchObject({
      ok: true,
      total: 1,
      notFollowedBack: 0,
      queued: 0,
    });
    expect(listPendingFollowBackEvents()).toHaveLength(0);
    expect(getAccount('mutual_friend')?.following_us).toBe(1);
    expect(getAccount('mutual_friend')?.followed_by_us).toBe(1);
  });

  it('auto-schedules a follow-back for safe classifications when enabled', async () => {
    const sendFollowerNotification = vi.fn().mockResolvedValue({ ok: true });

    vi.doMock('../../src/browser/followers.js', () => ({
      resolveOwnHandle: vi.fn().mockResolvedValue('my_handle'),
      fetchOurFollowerEntries: vi.fn().mockResolvedValue([
        { handle: 'safe_follower', followedByUs: false },
      ]),
      followBack: vi.fn(),
    }));
    vi.doMock('../../src/pipeline/classifier.js', () => ({
      classifyAccount: vi.fn().mockImplementation((handle: string) => Promise.resolve(mockAccount(handle))),
    }));
    vi.doMock('../../src/notifications/ntfy.js', () => ({
      sendFollowerNotification,
      sendUnfollowNotification: vi.fn().mockResolvedValue({ ok: true }),
    }));

    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('auto_follow_back_enabled', 'true');

    const { runFollowerSync } = await import('../../src/scheduler/follower_sync.js');
    const result = await runFollowerSync();

    expect(result).toMatchObject({ ok: true, queued: 1, autoScheduled: 1 });

    const { listFollowerEvents } = await import('../../src/storage/follower_events.js');
    const approved = listFollowerEvents('APPROVED');
    expect(approved).toHaveLength(1);
    expect(approved[0].account_handle).toBe('safe_follower');
    expect(approved[0].detail).toContain('auto_follow=true');
    expect(approved[0].scheduled_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // Auto-scheduled follows must not ping the user for approval
    expect(sendFollowerNotification).not.toHaveBeenCalled();
  });

  it('detects unfollows and notifies when a known follower disappears', async () => {
    const sendUnfollowNotification = vi.fn().mockResolvedValue({ ok: true });

    vi.doMock('../../src/browser/followers.js', () => ({
      resolveOwnHandle: vi.fn().mockResolvedValue('my_handle'),
      fetchOurFollowerEntries: vi.fn().mockResolvedValue([
        { handle: 'loyal_fan', followedByUs: true },
      ]),
      followBack: vi.fn(),
    }));
    vi.doMock('../../src/pipeline/classifier.js', () => ({
      classifyAccount: vi.fn().mockImplementation((handle: string) => Promise.resolve(mockAccount(handle))),
    }));
    vi.doMock('../../src/notifications/ntfy.js', () => ({
      sendFollowerNotification: vi.fn(),
      sendUnfollowNotification,
    }));

    // Seed two known followers; the scrape only returns one of them.
    const { setFollowerState, getAccount } = await import('../../src/storage/accounts.js');
    const { listFollowerEvents } = await import('../../src/storage/follower_events.js');
    setFollowerState('loyal_fan', true);
    setFollowerState('fickle_fan', true);

    const { runFollowerSync } = await import('../../src/scheduler/follower_sync.js');
    const result = await runFollowerSync();

    expect(result.ok).toBe(true);
    expect(getAccount('fickle_fan')?.following_us).toBe(0);
    expect(getAccount('loyal_fan')?.following_us).toBe(1);

    const unfollowEvents = listFollowerEvents().filter((e) => e.event_type === 'UNFOLLOWED');
    expect(unfollowEvents).toHaveLength(1);
    expect(unfollowEvents[0].account_handle).toBe('fickle_fan');
    expect(sendUnfollowNotification).toHaveBeenCalledWith(['fickle_fan']);
  });

  it('returns a visible failure when the account handle cannot be resolved', async () => {
    vi.doMock('../../src/browser/followers.js', () => ({
      resolveOwnHandle: vi.fn().mockResolvedValue(null),
      fetchOurFollowerEntries: vi.fn(),
      fetchOurFollowers: vi.fn(),
      followBack: vi.fn(),
    }));

    const { runFollowerSync } = await import('../../src/scheduler/follower_sync.js');
    const result = await runFollowerSync();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_handle');
    expect(result.message).toContain('Could not determine your X handle');
  });
});
