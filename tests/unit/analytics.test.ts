import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DB_RELATIVE = 'data/test-analytics.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

describe('analytics overview', () => {
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

  it('aggregates followers, reply classes, topic checkpoints, and posting hours', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { getDb } = await import('../../src/storage/db.js');
    const queries = await import('../../src/storage/queries.js');
    const accounts = await import('../../src/storage/accounts.js');
    const interactions = await import('../../src/storage/interactions.js');
    const originals = await import('../../src/storage/original_posts.js');

    const db = getDb();
    db.prepare(`
      INSERT INTO follower_events (account_handle, event_type, status, detected_at)
      VALUES ('new_one', 'NEW_FOLLOWER', 'PENDING', ?),
             ('gone_one', 'UNFOLLOWED', 'PENDING', ?)
    `).run(now - 3600, now - 1800);

    const source = queries.upsertPost({
      tweet_id: '1723456789012347001',
      author_handle: 'serious_author',
      author_name: 'Serious Author',
      text: 'Pune Metro service update.',
      timestamp: now - 7200,
      likes: 5,
      replies: 1,
      retweets: 0,
      tweet_url: 'https://x.com/serious_author/status/1723456789012347001',
    })!;
    accounts.setAccountClassification('serious_author', {
      classification: 'SERIOUS',
      confidence: 0.9,
      reasoning: 'test',
      model: 'test',
    });
    const interactionId = interactions.recordInteraction(
      source.id,
      'serious_author',
      'Useful reply.',
      { tweetId: '9999000011112222' },
    );
    interactions.updateInteractionMetrics(interactionId, {
      likes: 3,
      replies: 1,
      retweets: 0,
      impressions: 100,
    });
    queries.logEvent('APPROVE', 'test approval', source.id);
    queries.logEvent('SKIP', 'test skip', source.id);

    const original = originals.insertOriginalPost({
      content: 'Pune Metro is becoming a reliability test.',
      language: 'english',
      topic: 'pune metro',
    });
    originals.markOriginalPostPosted(
      original.id,
      ['8888000011112222'],
      ['https://x.com/i/web/status/8888000011112222'],
    );
    originals.insertImpression({
      originalPostId: original.id,
      tweetId: '8888000011112222',
      impressions: 500,
      likes: 10,
      replies: 2,
      retweets: 1,
    });

    const { getAnalyticsOverview } = await import('../../src/storage/analytics.js');
    const result = getAnalyticsOverview(30);

    expect(result.summary).toMatchObject({
      follower_delta: 0,
      replies: 1,
      originals: 1,
      successful_replies: 1,
    });
    expect(result.reply_by_classification[0]).toMatchObject({
      classification: 'SERIOUS',
      total_replies: 1,
      successful_replies: 1,
    });
    expect(result.topic_trends[0]).toMatchObject({
      topic: 'pune metro',
      impressions: 500,
      likes: 10,
    });
    expect(result.posting_hours.length).toBeGreaterThan(0);
    expect(result.follower_growth.reduce((sum, row) => sum + row.gained, 0)).toBe(1);
    expect(result.follower_growth.reduce((sum, row) => sum + row.lost, 0)).toBe(1);

    const { getWeeklyDigest } = await import('../../src/storage/digest.js');
    const digest = getWeeklyDigest(now + 60);
    expect(digest).toMatchObject({
      replies_posted: 1,
      originals_posted: 1,
      approval_rate: 50,
      follower_delta: 0,
    });
    expect(digest.top_reply?.success_score).toBeGreaterThan(0);
    expect(digest.best_topic?.topic).toBe('pune metro');
  });

  it('breaks reply performance down by source (TIMELINE vs TREND)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const queries = await import('../../src/storage/queries.js');
    const interactions = await import('../../src/storage/interactions.js');

    // Timeline post → reply with metric sync
    const timelinePost = queries.upsertPost({
      tweet_id: 'tl_tweet_001',
      author_handle: 'user_a',
      author_name: 'User A',
      text: 'Timeline tweet',
      timestamp: now - 3600,
      likes: 5, replies: 1, retweets: 0,
      tweet_url: 'https://x.com/user_a/status/tl_tweet_001',
    })!;
    // source defaults to TIMELINE on insert

    const tlId = interactions.recordInteraction(
      timelinePost.id, 'user_a', 'Timeline reply', { tweetId: 'our_tl_001' },
    );
    interactions.updateInteractionMetrics(tlId, {
      likes: 10, replies: 2, retweets: 1, impressions: 400,
    });

    // Trend post → reply with metric sync
    const trendPost = queries.upsertPost({
      tweet_id: 'tr_tweet_001',
      author_handle: 'user_b',
      author_name: 'User B',
      text: '#TrendingTopic tweet',
      timestamp: now - 3600,
      likes: 500, replies: 200, retweets: 80,
      tweet_url: 'https://x.com/user_b/status/tr_tweet_001',
    }, { source: 'TREND_GLOBAL', trendKey: '#TrendingTopic' })!;

    const trId = interactions.recordInteraction(
      trendPost.id, 'user_b', 'Trend reply', { tweetId: 'our_tr_001' },
    );
    interactions.updateInteractionMetrics(trId, {
      likes: 2, replies: 0, retweets: 0, impressions: 80,
    });

    // A reply without metric sync should be excluded from source breakdown
    const unsyncedPost = queries.upsertPost({
      tweet_id: 'un_tweet_001',
      author_handle: 'user_a',
      author_name: 'User A',
      text: 'Unsynced tweet',
      timestamp: now - 7200,
      likes: 1, replies: 0, retweets: 0,
      tweet_url: 'https://x.com/user_a/status/un_tweet_001',
    })!;
    interactions.recordInteraction(
      unsyncedPost.id, 'user_a', 'Unsynced reply', { tweetId: 'our_un_001' },
    );

    const { getAnalyticsOverview } = await import('../../src/storage/analytics.js');
    const result = getAnalyticsOverview(30);

    expect(result.reply_by_source).toHaveLength(2);
    const tl = result.reply_by_source.find((r) => r.source === 'TIMELINE');
    const tr = result.reply_by_source.find((r) => r.source === 'TREND_GLOBAL');
    expect(tl).toBeDefined();
    expect(tl!.total_replies).toBe(1);
    expect(tl!.avg_impressions).toBeGreaterThan(0);
    expect(tr).toBeDefined();
    expect(tr!.total_replies).toBe(1);
    // TIMELINE should outperform TREND in this fixture (10 likes vs 2 likes)
    expect(tl!.avg_success_score).toBeGreaterThan(tr!.avg_success_score);
  });
});
