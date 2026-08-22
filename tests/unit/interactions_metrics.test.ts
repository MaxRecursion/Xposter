import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

const TEST_DB_RELATIVE = 'data/test-interactions-metrics.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

describe('reply metric sync storage', () => {
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

  async function seedReply() {
    const { upsertPost } = await import('../../src/storage/queries.js');
    const interactions = await import('../../src/storage/interactions.js');

    const post = upsertPost({
      tweet_id: '1723456789012347001',
      author_handle: 'movie_user',
      author_name: 'Movie User',
      text: 'Original tweet',
      timestamp: Math.floor(Date.now() / 1000) - 300,
      likes: 1, replies: 0, retweets: 0,
      tweet_url: 'https://x.com/movie_user/status/1723456789012347001',
    })!;

    const interactionId = interactions.recordInteraction(
      post.id, 'movie_user', 'our reply text',
      { tweetId: '9999000011112222', tweetUrl: 'https://x.com/i/web/status/9999000011112222' },
    );
    return { interactions, interactionId };
  }

  it('returns never-checked replies as due, then excludes them after a check', async () => {
    const { interactions, interactionId } = await seedReply();

    const due = interactions.getInteractionsNeedingMetricSync({
      olderThanSeconds: 6 * 3600,
      postedWithinSeconds: 7 * 24 * 3600,
      limit: 10,
    });
    expect(due.map((d) => d.id)).toContain(interactionId);

    interactions.updateInteractionMetrics(interactionId, { likes: 3, replies: 1, retweets: 0, impressions: 120 });

    const dueAfter = interactions.getInteractionsNeedingMetricSync({
      olderThanSeconds: 6 * 3600,
      postedWithinSeconds: 7 * 24 * 3600,
      limit: 10,
    });
    expect(dueAfter.map((d) => d.id)).not.toContain(interactionId);
  });

  it('refreshes account aggregates from interaction metrics', async () => {
    const { interactions, interactionId } = await seedReply();

    // likes*1 + replies*13 + retweets*20 = 3 + 13 = 16
    interactions.updateInteractionMetrics(interactionId, { likes: 3, replies: 1, retweets: 0, impressions: 120 });
    interactions.refreshAccountReplyStats('movie_user');

    const { getAccount } = await import('../../src/storage/accounts.js');
    const account = getAccount('movie_user')!;
    expect(account.total_engagement).toBe(4);
    expect(account.avg_reply_score).toBe(16);
    expect(account.successful_replies).toBe(1);
    expect(account.author_engaged_replies).toBe(0);
  });

  it('counts author_engaged toward success_score and account stats', async () => {
    const { interactions, interactionId } = await seedReply();
    interactions.updateInteractionMetrics(interactionId, {
      likes: 0, replies: 0, retweets: 0, impressions: 40, authorEngaged: true,
    });
    interactions.refreshAccountReplyStats('movie_user');

    const { getAccount } = await import('../../src/storage/accounts.js');
    const account = getAccount('movie_user')!;
    expect(account.author_engaged_replies).toBe(1);
    expect(account.avg_reply_score).toBe(25);
  });
});
