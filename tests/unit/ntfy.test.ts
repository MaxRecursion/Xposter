import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.fn();

vi.mock('axios', () => ({
  default: {
    post: postMock,
  },
}));

describe('ntfy notification links', () => {
  const originalEnv = {
    NTFY_TOPIC: process.env.NTFY_TOPIC,
    NTFY_SERVER: process.env.NTFY_SERVER,
    CALLBACK_BASE_URL: process.env.CALLBACK_BASE_URL,
    API_KEY: process.env.API_KEY,
  };

  beforeEach(() => {
    vi.resetModules();
    postMock.mockReset();
    postMock.mockResolvedValue({ status: 200, data: {} });
    process.env.NTFY_TOPIC = 'test-topic';
    process.env.NTFY_SERVER = 'https://ntfy.example.com';
    process.env.CALLBACK_BASE_URL = 'http://127.0.0.1:3000';
    process.env.API_KEY = 'test-api-key';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses an X app deep link for reply notifications', async () => {
    const { sendReplyPostedNotification } = await import('../../src/notifications/ntfy.js');

    await sendReplyPostedNotification({
      id: 'post-1',
      tweet_id: '1723456789012347001',
      author_handle: 'movie_user',
      author_name: 'Movie User',
      text: 'Original tweet that we replied to.',
      language: 'english',
      timestamp: Math.floor(Date.now() / 1000) - 300,
      likes: 2,
      replies: 0,
      retweets: 0,
      tweet_url: 'https://x.com/movie_user/status/1723456789012347001',
      status: 'POSTED',
      score: 71,
      score_breakdown: null,
      generated_reply: 'That sounds like a fun watch.',
      final_reply: 'That sounds like a fun watch.',
      posted_tweet_id: '9999000011112222',
      deleted_at: null,
      ingested_at: Math.floor(Date.now() / 1000) - 320,
      updated_at: Math.floor(Date.now() / 1000) - 60,
    }, 'That sounds like a fun watch.', '9999000011112222', 'REGULAR');

    const payload = postMock.mock.calls[0]?.[1];
    expect(payload.actions[1].label).toBe('Open on X');
    expect(payload.actions[1].url).toBe('twitter://status?status_id=9999000011112222');
    expect(payload.click).toBe('twitter://status?status_id=9999000011112222');
  });

  it('uses an X app deep link for follower profile actions', async () => {
    const { sendFollowerNotification } = await import('../../src/notifications/ntfy.js');

    await sendFollowerNotification(42, '@puneri_user', null);

    const payload = postMock.mock.calls[0]?.[1];
    expect(payload.actions[2].label).toBe('Open profile');
    expect(payload.actions[2].url).toBe('twitter://user?screen_name=puneri_user');
  });

  it('sends session-expiry alerts at maximum priority', async () => {
    const { sendSessionExpiredNotification } = await import('../../src/notifications/ntfy.js');

    await sendSessionExpiredNotification();

    const payload = postMock.mock.calls[0]?.[1];
    expect(payload.priority).toBe(5);
    expect(payload.title).toContain('Session Expired');
  });

  it('formats the weekly digest metrics', async () => {
    const { sendWeeklyDigestNotification } = await import('../../src/notifications/ntfy.js');

    await sendWeeklyDigestNotification({
      since: 1,
      until: 2,
      replies_posted: 12,
      originals_posted: 5,
      approval_rate: 75,
      approvals: 3,
      skips: 1,
      follower_delta: 4,
      followers_gained: 6,
      followers_lost: 2,
      top_reply: {
        text: 'A strong reply.',
        author_handle: 'author',
        tweet_url: 'https://x.com/i/web/status/1',
        success_score: 20,
        likes: 4,
        replies: 1,
        retweets: 0,
      },
      best_topic: {
        topic: 'pune metro',
        posts: 2,
        avg_engagement_score: 24,
      },
    });

    const payload = postMock.mock.calls[0]?.[1];
    expect(payload.title).toContain('Weekly Digest');
    expect(payload.message).toContain('Replies posted: 12');
    expect(payload.message).toContain('Approval rate: 75%');
    expect(payload.message).toContain('Follower delta: +4');
    expect(payload.message).toContain('Best topic: pune metro');
  });
});
