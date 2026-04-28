import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';

const TEST_DB_RELATIVE = 'data/test-pipeline-run.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

describe('runPipeline', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
    process.env.GROQ_API_KEY = 'mock-key';
  });

  afterEach(() => {
    vi.doUnmock('../../src/browser/ingestion.js');
    vi.doUnmock('../../src/browser/posting.js');
    vi.doUnmock('../../src/pipeline/classifier.js');
    vi.doUnmock('../../src/pipeline/generator.js');
    vi.doUnmock('../../src/notifications/ntfy.js');
    delete process.env.DB_PATH_OVERRIDE;
    delete process.env.GROQ_API_KEY;
    removeTestDb();
  });

  it('auto-posts the fallback reply and notifies via ntfy', async () => {
    const tweet = {
      tweet_id: '1723456789012347001',
      author_handle: 'movie_user',
      author_name: 'Movie User',
      text: 'Just watched an amazing movie last night. Highly recommend it.',
      timestamp: Math.floor(Date.now() / 1000) - 300,
      likes: 2,
      replies: 0,
      retweets: 0,
      tweet_url: 'https://x.com/movie_user/status/1723456789012347001',
    };

    vi.doMock('../../src/browser/ingestion.js', () => ({
      ingestTimeline: vi.fn().mockResolvedValue([tweet]),
    }));
    vi.doMock('../../src/pipeline/classifier.js', () => ({
      classifyAccount: vi.fn().mockResolvedValue({
        handle: 'movie_user',
        display_name: 'Movie User',
        bio: null,
        bio_fetched_at: null,
        classification: 'REGULAR',
        classification_confidence: 0.8,
        classification_reasoning: 'mocked',
        classified_at: Math.floor(Date.now() / 1000),
        classification_model: 'mock',
        is_marathi_creator: 0,
        verified: 0,
        follower_count_seen: 100,
        following_count_seen: 50,
        followed_by_us: 0,
        following_us: 0,
        mutual_follow: 0,
        blocked_or_muted: 0,
        total_replies_sent: 0,
        total_engagement: 0,
        avg_reply_score: 0,
        successful_replies: 0,
        first_seen_at: Math.floor(Date.now() / 1000),
        last_seen_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      }),
    }));
    vi.doMock('../../src/pipeline/generator.js', () => ({
      generateReply: vi.fn().mockResolvedValue('That sounds like a fun watch.'),
    }));
    const postReplyMock = vi.fn().mockResolvedValue({ replyTweetId: '9999000011112222' });
    vi.doMock('../../src/browser/posting.js', () => ({
      postReply: postReplyMock,
      deleteReply: vi.fn(),
    }));
    const notifyMock = vi.fn().mockResolvedValue({ ok: true, topic: 'test-topic' });
    vi.doMock('../../src/notifications/ntfy.js', () => ({
      sendReplyPostedNotification: notifyMock,
    }));

    const { runPipeline } = await import('../../src/scheduler/cron.js');
    const result = await runPipeline();

    const { getPostByTweetId } = await import('../../src/storage/queries.js');
    const post = getPostByTweetId(tweet.tweet_id);

    expect(result).toEqual({ ingested: 1, candidates: 1 });
    expect(post?.status).toBe('POSTED');
    expect(post?.posted_tweet_id).toBe('9999000011112222');
    expect(post?.generated_reply).toBe('That sounds like a fun watch.');
    expect(post?.score).not.toBeNull();

    expect(postReplyMock).toHaveBeenCalledWith(tweet.tweet_url, 'That sounds like a fun watch.');
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const notifyArgs = notifyMock.mock.calls[0];
    expect(notifyArgs[1]).toBe('That sounds like a fun watch.');
    expect(notifyArgs[2]).toBe('9999000011112222');
    expect(notifyArgs[3]).toBe('REGULAR');
  });
});
