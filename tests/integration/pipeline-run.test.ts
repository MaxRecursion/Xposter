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
    vi.doUnmock('../../src/pipeline/generator.js');
    vi.doUnmock('../../src/notifications/ntfy.js');
    delete process.env.DB_PATH_OVERRIDE;
    delete process.env.GROQ_API_KEY;
    removeTestDb();
  });

  it('generates one fallback reply when no tweet passes the normal filters', async () => {
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
    vi.doMock('../../src/pipeline/generator.js', () => ({
      generateReply: vi.fn().mockResolvedValue('That sounds like a fun watch.'),
    }));
    vi.doMock('../../src/notifications/ntfy.js', () => ({
      sendApprovalNotification: vi.fn().mockResolvedValue({ ok: true, topic: 'test-topic' }),
    }));

    const { runPipeline } = await import('../../src/scheduler/cron.js');
    const result = await runPipeline();

    const { getPostByTweetId } = await import('../../src/storage/queries.js');
    const post = getPostByTweetId(tweet.tweet_id);

    expect(result).toEqual({ ingested: 1, candidates: 1 });
    expect(post?.status).toBe('PENDING_APPROVAL');
    expect(post?.generated_reply).toBe('That sounds like a fun watch.');
    expect(post?.score).not.toBeNull();
  });
});
