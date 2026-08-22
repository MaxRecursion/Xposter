import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

const TEST_DB_RELATIVE = 'data/test-velocity-pool.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

const now = () => Math.floor(Date.now() / 1000);

describe('velocity candidate pool storage', () => {
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

  async function seed(tweetId: string, over: Record<string, unknown> = {}) {
    const { upsertPost } = await import('../../src/storage/queries.js');
    return upsertPost({
      tweet_id: tweetId,
      author_handle: 'someone',
      author_name: 'Someone',
      text: 'A tweet about Pune traffic',
      timestamp: now() - 600,
      likes: 5, replies: 1, retweets: 0,
      tweet_url: `https://x.com/someone/status/${tweetId}`,
      ...over,
    })!;
  }

  it('stores a later sighting without disturbing the original counts', async () => {
    const posts = await import('../../src/storage/posts.js');
    const post = await seed('1000000000000000001');

    posts.recordObservation('1000000000000000001', 250, 9);

    const after = posts.getPost(post.id)!;
    expect(after.likes).toBe(5);          // first sighting preserved
    expect(after.obs_likes).toBe(250);    // second sighting recorded alongside
    expect(after.obs_replies).toBe(9);
    expect(after.obs_at).toBeGreaterThan(0);
    expect(after.status).toBe('INGESTED');
  });

  it('refuses to re-observe a candidate we already acted on', async () => {
    const posts = await import('../../src/storage/posts.js');
    const post = await seed('1000000000000000002');
    posts.updatePostStatus(post.id, 'POSTED');

    posts.recordObservation('1000000000000000002', 900, 40);

    // A duplicate sighting must never revive a decided candidate.
    expect(posts.getPost(post.id)!.obs_likes).toBeNull();
  });

  it('returns un-actioned candidates from earlier runs', async () => {
    const posts = await import('../../src/storage/posts.js');
    await seed('1000000000000000003');
    await seed('1000000000000000004');

    const pool = posts.getPoolCandidates(45);
    expect(pool.map((p) => p.tweet_id).sort()).toEqual([
      '1000000000000000003', '1000000000000000004',
    ]);
  });

  it('excludes candidates already replied to, skipped, or filtered', async () => {
    const posts = await import('../../src/storage/posts.js');
    const kept = await seed('1000000000000000005');
    for (const [id, status] of [
      ['1000000000000000006', 'POSTED'],
      ['1000000000000000007', 'SKIPPED'],
      ['1000000000000000008', 'FILTERED'],
    ] as const) {
      const p = await seed(id);
      posts.updatePostStatus(p.id, status);
    }

    const pool = posts.getPoolCandidates(45);
    expect(pool.map((p) => p.id)).toEqual([kept.id]);
  });

  it('drops candidates older than the pool window', async () => {
    const posts = await import('../../src/storage/posts.js');
    const { getDb } = await import('../../src/storage/db.js');
    const stale = await seed('1000000000000000009');
    getDb().prepare('UPDATE posts SET ingested_at = ? WHERE id = ?')
      .run(now() - 3 * 3600, stale.id);

    expect(posts.getPoolCandidates(45)).toHaveLength(0);
    expect(posts.getPoolCandidates(240)).toHaveLength(1);
  });
});

describe('velocity pool never re-answers a tweet', () => {
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

  it('excludes a post we already replied to, even if its status never moved', async () => {
    const { upsertPost } = await import('../../src/storage/queries.js');
    const posts = await import('../../src/storage/posts.js');
    const { recordInteraction } = await import('../../src/storage/interactions.js');

    const answered = upsertPost({
      tweet_id: '1000000000000000010', author_handle: 'seed_user', author_name: 'Seed',
      text: 'A tweet about Pune traffic', timestamp: now() - 600,
      likes: 5, replies: 1, retweets: 0,
      tweet_url: 'https://x.com/seed_user/status/1000000000000000010',
    })!;
    recordInteraction(answered.id, 'seed_user', 'our earlier reply');

    // Still INGESTED — only the interaction row proves we answered it.
    expect(posts.getPost(answered.id)!.status).toBe('INGESTED');
    expect(posts.getPoolCandidates(45).map((p) => p.id)).not.toContain(answered.id);
  });
});

describe('velocity pool respects the trend safety boundary', () => {
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

  it('never carries a trend-sourced candidate into the timeline path', async () => {
    // A trend post rejected by the per-post safety classifier must not be able
    // to reach the timeline path, which has no equivalent trend safety gate.
    const { upsertPost } = await import('../../src/storage/queries.js');
    const posts = await import('../../src/storage/posts.js');

    const trendPost = upsertPost({
      tweet_id: '1000000000000000011', author_handle: 'trend_user', author_name: 'Trend',
      text: 'Heartbreaking news, he passed away this morning.', timestamp: now() - 300,
      likes: 400, replies: 3, retweets: 10,
      tweet_url: 'https://x.com/trend_user/status/1000000000000000011',
    }, { source: 'TREND_GLOBAL', trendKey: 'formula1' })!;

    expect(posts.getPost(trendPost.id)!.status).toBe('INGESTED');
    expect(posts.getPoolCandidates(45).map((p) => p.id)).not.toContain(trendPost.id);
  });
});
