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
});
