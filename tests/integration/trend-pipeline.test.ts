import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';

const TEST_DB_RELATIVE = 'data/test-trend-pipeline.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

const now = () => Math.floor(Date.now() / 1000);

function tweet(overrides: Record<string, unknown> = {}) {
  const id = String(overrides.tweet_id ?? '1823456789012340001');
  const handle = String(overrides.author_handle ?? 'trend_user');
  return {
    tweet_id: id,
    author_handle: handle,
    author_name: 'Trend User',
    text: 'The new pricing model completely changes the calculus for anyone building on this platform right now.',
    timestamp: now() - 3600,
    likes: 5000,
    replies: 40,
    retweets: 900,
    tweet_url: `https://x.com/${handle}/status/${id}`,
    ...overrides,
  };
}

/**
 * Filler results that fail the substance filter.
 *
 * Their only job is to push the raw result count past the Latest top-up
 * threshold, so the search path doesn't sleep for a second pass mid-test.
 */
function filler(n: number) {
  return Array.from({ length: n }, (_, i) => tweet({
    tweet_id: `19000000000000000${i}`,
    author_handle: `filler_${i}`,
    text: 'short',
  }));
}

/**
 * Seeds `trends` so selectEligibleTrends has something to pick, plus a fresh
 * `trend_snapshots` row so refreshTrendsIfStale considers the cache warm and
 * doesn't reach for the network.
 */
async function seedTrend(opts: { name: string; woeid: number; safety: string }): Promise<void> {
  const { getDb } = await import('../../src/storage/db.js');
  const db = getDb();
  db.prepare(`
    INSERT INTO trends (
      key, woeid, name, query, first_seen_at, last_seen_at,
      best_rank, last_rank, prev_rank, poll_count, script, safety_class, classified_at
    ) VALUES (?, ?, ?, ?, ?, ?, 3, 3, 5, 1, 'latin', ?, ?)
  `).run(
    `${opts.woeid}:${opts.name.toLowerCase()}`, opts.woeid, opts.name, opts.name,
    now(), now(), opts.safety, now(),
  );
  await seedFreshSnapshots();
}

/** Marks both locations as just-polled so no live fetch is attempted. */
async function seedFreshSnapshots(): Promise<void> {
  const { getDb } = await import('../../src/storage/db.js');
  for (const woeid of [1, 23424848]) {
    getDb().prepare(`
      INSERT INTO trend_snapshots (woeid, name, query, url, rank, tweet_volume, captured_at)
      VALUES (?, 'seed', 'seed', NULL, 99, NULL, ?)
    `).run(woeid, now());
  }
}

function mockCommon(generateReply: ReturnType<typeof vi.fn>, postReply: ReturnType<typeof vi.fn>) {
  vi.doMock('../../src/pipeline/classifier.js', () => ({
    classifyAccount: vi.fn().mockResolvedValue(null),
  }));
  vi.doMock('../../src/pipeline/generator.js', () => ({ generateReply }));
  vi.doMock('../../src/browser/posting.js', () => ({ postReply, deleteReply: vi.fn() }));
  vi.doMock('../../src/notifications/ntfy.js', () => ({
    sendApprovalNotification: vi.fn().mockResolvedValue({ ok: true }),
    sendReplyPostedNotification: vi.fn().mockResolvedValue({ ok: true }),
  }));
}

describe('trend-sourced reply pipeline', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
    process.env.GROQ_API_KEY = 'mock-key';
  });

  afterEach(() => {
    for (const mod of [
      '../../src/browser/ingestion.js', '../../src/browser/posting.js',
      '../../src/pipeline/classifier.js', '../../src/pipeline/generator.js',
      '../../src/notifications/ntfy.js', '../../src/trends/x_trends.js',
    ]) vi.doUnmock(mod);
    delete process.env.DB_PATH_OVERRIDE;
    delete process.env.GROQ_API_KEY;
    removeTestDb();
  });

  it('sources candidates from a trend, tags the row, and posts', async () => {
    const searchTweets = vi.fn().mockResolvedValue([
      tweet({ text: 'Everyone says this pricing model is a win but the calculus for small teams just got much worse.' }),
      ...filler(5),
    ]);
    vi.doMock('../../src/browser/ingestion.js', () => ({
      ingestTimeline: vi.fn().mockResolvedValue([]),
      searchTweets,
    }));
    const postReply = vi.fn().mockResolvedValue({ replyTweetId: '9999000011112222' });
    mockCommon(vi.fn().mockResolvedValue('Worth pricing in the switching cost before calling it a win.'), postReply);

    const { runReplyPipeline } = await import('../../src/pipeline/reply_pipeline.js');
    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('require_approval', 'false');
    await seedTrend({ name: 'pricing', woeid: 1, safety: 'SAFE_FOR_CONTRARIAN' });

    const result = await runReplyPipeline({ source: 'TREND_GLOBAL' });

    const { getPostByTweetId } = await import('../../src/storage/queries.js');
    const post = getPostByTweetId('1823456789012340001');

    expect(searchTweets).toHaveBeenCalled();
    expect(result.candidates).toBe(1);
    expect(post?.status).toBe('POSTED');
    expect(post?.source).toBe('TREND_GLOBAL');
    expect(post?.trend_key).toBe('1:pricing');
    expect(post?.stance).toBeTruthy();
    expect(postReply).toHaveBeenCalled();
  });

  it('never assigns a contrarian stance on a STRAIGHT_ONLY trend', async () => {
    vi.doMock('../../src/browser/ingestion.js', () => ({
      ingestTimeline: vi.fn().mockResolvedValue([]),
      searchTweets: vi.fn().mockResolvedValue([
        tweet({
          tweet_id: '1823456789012340002',
          // Must mention the trend or the relevance net drops it before stance
          // assignment ever runs.
          text: 'The election result here is going to reshape how the whole state budgets for infrastructure next year.',
        }),
        ...filler(5),
      ]),
    }));
    const generateReply = vi.fn().mockResolvedValue('Worth watching how the rollout actually lands.');
    mockCommon(generateReply, vi.fn().mockResolvedValue({ replyTweetId: '8888' }));

    const { runReplyPipeline } = await import('../../src/pipeline/reply_pipeline.js');
    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('require_approval', 'false');
    // 100% contrarian target — safety must still override it.
    setSetting('contrarian_reply_pct', '100');
    await seedTrend({ name: 'election', woeid: 23424848, safety: 'STRAIGHT_ONLY' });

    await runReplyPipeline({ source: 'TREND_INDIA' });

    const { getPostByTweetId } = await import('../../src/storage/queries.js');
    const post = getPostByTweetId('1823456789012340002');

    expect(post?.stance).toBe('ALIGNED');
    expect(generateReply.mock.calls[0][2]).toMatchObject({ stance: 'ALIGNED' });
  });

  it('drops a candidate whose own text is about a death, even on a safe trend', async () => {
    vi.doMock('../../src/browser/ingestion.js', () => ({
      ingestTimeline: vi.fn().mockResolvedValue([]),
      searchTweets: vi.fn().mockResolvedValue([
        tweet({
          tweet_id: '1823456789012340003',
          // Mentions the trend so it clears the relevance net and actually
          // reaches the per-post safety classifier we're testing.
          text: 'Absolutely heartbreaking news for formula1, he passed away this morning after a long illness. Rest in peace legend.',
        }),
        ...filler(5),
      ]),
    }));
    const postReply = vi.fn();
    mockCommon(vi.fn().mockResolvedValue('nope'), postReply);

    const { runReplyPipeline } = await import('../../src/pipeline/reply_pipeline.js');
    await seedTrend({ name: 'formula1', woeid: 1, safety: 'SAFE_FOR_CONTRARIAN' });

    await runReplyPipeline({ source: 'TREND_GLOBAL' });

    expect(postReply).not.toHaveBeenCalled();
  });

  it('falls through to the home timeline when trend sourcing yields nothing', async () => {
    const timelineTweet = tweet({
      tweet_id: '1823456789012340004',
      author_handle: 'timeline_user',
      text: 'Heavy rain in Pune again, Baner roads are completely waterlogged this evening.',
      likes: 4, replies: 1, retweets: 0,
      timestamp: now() - 300,
    });
    const ingestTimeline = vi.fn().mockResolvedValue([timelineTweet]);
    // No trends seeded, so trend sourcing returns nothing at all.
    vi.doMock('../../src/browser/ingestion.js', () => ({
      ingestTimeline,
      searchTweets: vi.fn().mockResolvedValue([]),
    }));
    const postReply = vi.fn().mockResolvedValue({ replyTweetId: '7777' });
    mockCommon(vi.fn().mockResolvedValue('Baner drainage doing its annual disappearing act.'), postReply);

    const { runReplyPipeline } = await import('../../src/pipeline/reply_pipeline.js');
    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('require_approval', 'false');
    await seedFreshSnapshots();

    const result = await runReplyPipeline({ source: 'TREND_GLOBAL' });

    const { getPostByTweetId } = await import('../../src/storage/queries.js');
    const post = getPostByTweetId('1823456789012340004');

    expect(ingestTimeline).toHaveBeenCalled();
    expect(result.candidates).toBe(1);
    expect(post?.status).toBe('POSTED');
    expect(post?.source).toBe('TIMELINE');
  });

  it('defaults to the timeline path when called with no source', async () => {
    const ingestTimeline = vi.fn().mockResolvedValue([]);
    const searchTweets = vi.fn();
    vi.doMock('../../src/browser/ingestion.js', () => ({ ingestTimeline, searchTweets }));
    mockCommon(vi.fn(), vi.fn());

    const { runReplyPipeline } = await import('../../src/pipeline/reply_pipeline.js');
    await runReplyPipeline();

    expect(ingestTimeline).toHaveBeenCalled();
    expect(searchTweets).not.toHaveBeenCalled();
  });
});
