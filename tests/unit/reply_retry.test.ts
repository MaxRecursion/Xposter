import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DB_RELATIVE = 'data/test-reply-retry.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

describe('reply retry queue', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
  });

  afterEach(() => {
    vi.doUnmock('../../src/browser/posting.js');
    vi.doUnmock('../../src/notifications/ntfy.js');
    delete process.env.DB_PATH_OVERRIDE;
    removeTestDb();
  });

  it('posts a due transient failure once on the next queue run', async () => {
    const postReply = vi.fn().mockResolvedValue({ replyTweetId: '9999000011112222' });
    vi.doMock('../../src/browser/posting.js', () => ({ postReply, deleteReply: vi.fn() }));
    vi.doMock('../../src/notifications/ntfy.js', () => ({
      sendReplyPostedNotification: vi.fn().mockResolvedValue({ ok: true }),
    }));

    const queries = await import('../../src/storage/queries.js');
    const post = queries.upsertPost({
      tweet_id: '1723456789012347001',
      author_handle: 'retry_user',
      author_name: 'Retry User',
      text: 'Pune traffic is stalled near Baner.',
      timestamp: Math.floor(Date.now() / 1000) - 300,
      likes: 2,
      replies: 0,
      retweets: 0,
      tweet_url: 'https://x.com/retry_user/status/1723456789012347001',
    })!;
    queries.updateGeneratedReply(post.id, 'Baner traffic has entered its residency era.');
    queries.updatePostStatus(post.id, 'POSTING');
    queries.incrementPostingAttempt(post.id);
    queries.schedulePostRetry(post.id, 'COMPOSE_NOT_FOUND: compose missing');

    const { runReplyRetryQueue } = await import('../../src/scheduler/reply_retry.js');
    const result = await runReplyRetryQueue();

    expect(result).toEqual({ due: 1, posted: 1, failed: 0 });
    expect(postReply).toHaveBeenCalledTimes(1);
    expect(queries.getPost(post.id)).toMatchObject({
      status: 'POSTED',
      posting_attempts: 2,
      retry_after: null,
      last_error: null,
      posted_tweet_id: '9999000011112222',
    });
  });

  it('does not queue permanent posting failures', async () => {
    vi.doMock('../../src/browser/posting.js', () => ({
      postReply: vi.fn().mockRejectedValue(new Error('Source tweet was deleted')),
      deleteReply: vi.fn(),
    }));
    vi.doMock('../../src/notifications/ntfy.js', () => ({
      sendReplyPostedNotification: vi.fn(),
    }));

    const queries = await import('../../src/storage/queries.js');
    const post = queries.upsertPost({
      tweet_id: '1723456789012347002',
      author_handle: 'deleted_user',
      author_name: 'Deleted User',
      text: 'A source tweet that disappears.',
      timestamp: Math.floor(Date.now() / 1000) - 300,
      likes: 0,
      replies: 0,
      retweets: 0,
      tweet_url: 'https://x.com/deleted_user/status/1723456789012347002',
    })!;
    queries.updateGeneratedReply(post.id, 'A reply that should not retry.');
    queries.updatePostStatus(post.id, 'POSTING');

    const { publishReply } = await import('../../src/pipeline/reply_publisher.js');
    expect(await publishReply(post, 'A reply that should not retry.', null)).toBe('error');
    expect(queries.getPost(post.id)).toMatchObject({
      status: 'ERROR',
      posting_attempts: 1,
      retry_after: null,
    });
  });

  it('queues a first transient posting failure with one retry remaining', async () => {
    vi.doMock('../../src/browser/posting.js', () => ({
      postReply: vi.fn().mockRejectedValue(new Error('Compose box not found after clicking reply')),
      deleteReply: vi.fn(),
    }));
    vi.doMock('../../src/notifications/ntfy.js', () => ({
      sendReplyPostedNotification: vi.fn(),
    }));

    const queries = await import('../../src/storage/queries.js');
    const post = queries.upsertPost({
      tweet_id: '1723456789012347003',
      author_handle: 'transient_user',
      author_name: 'Transient User',
      text: 'A source tweet whose compose UI did not load.',
      timestamp: Math.floor(Date.now() / 1000) - 300,
      likes: 0,
      replies: 0,
      retweets: 0,
      tweet_url: 'https://x.com/transient_user/status/1723456789012347003',
    })!;
    queries.updateGeneratedReply(post.id, 'A reply waiting for one safe retry.');
    queries.updatePostStatus(post.id, 'POSTING');

    const { publishReply } = await import('../../src/pipeline/reply_publisher.js');
    expect(await publishReply(post, 'A reply waiting for one safe retry.', null))
      .toBe('retry_scheduled');
    expect(queries.getPost(post.id)).toMatchObject({
      status: 'ERROR',
      posting_attempts: 1,
      last_error: expect.stringContaining('COMPOSE_NOT_FOUND'),
    });
    expect(queries.getPost(post.id)?.retry_after).not.toBeNull();
  });
});
