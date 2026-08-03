import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

const TEST_DB_RELATIVE = 'data/test-engagement-performance.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

describe('engagement performance storage', () => {
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

  let seq = 0;
  async function seedBaitReply(mode: string, score: number) {
    const { upsertPost, updatePostEngagementMode } = await import('../../src/storage/queries.js');
    const interactions = await import('../../src/storage/interactions.js');

    seq += 1;
    const tweetId = `1990000000000000${String(seq).padStart(3, '0')}`;
    const post = upsertPost({
      tweet_id: tweetId,
      author_handle: 'perf_user',
      author_name: 'Perf User',
      text: 'Source tweet about traffic',
      timestamp: Math.floor(Date.now() / 1000) - 600,
      likes: 2, replies: 0, retweets: 0,
      tweet_url: `https://x.com/perf_user/status/${tweetId}`,
    })!;
    expect(post).toBeTruthy();
    updatePostEngagementMode(post.id, mode);

    const id = interactions.recordInteraction(post.id, 'perf_user', `reply ${mode} ${score}`);
    interactions.updateInteractionMetrics(id, {
      likes: score,
      replies: 0,
      retweets: 0,
      impressions: 100,
    });
  }

  it('aggregates mode performance across replies', async () => {
    await seedBaitReply('CLICKBAIT', 10);
    await seedBaitReply('CLICKBAIT', 8);
    await seedBaitReply('RAGEBAIT', 2);

    const { getModePerformance } = await import('../../src/storage/engagement_performance.js');
    const rows = getModePerformance(30);
    const click = rows.find((r) => r.mode === 'CLICKBAIT');
    const rage = rows.find((r) => r.mode === 'RAGEBAIT');
    expect(click?.count).toBe(2);
    expect(rage?.count).toBe(1);
    expect(click!.avg_score).toBeGreaterThan(rage!.avg_score);
  });

  it('biases click subtype prob toward the better-performing mode', async () => {
    await seedBaitReply('CLICKBAIT', 20);
    await seedBaitReply('CLICKBAIT', 18);
    await seedBaitReply('CLICKBAIT', 16);
    await seedBaitReply('RAGEBAIT', 2);
    await seedBaitReply('RAGEBAIT', 1);
    await seedBaitReply('RAGEBAIT', 1);

    const { computeClickSubtypeProb, getModePerformance } = await import('../../src/storage/engagement_performance.js');
    const prob = computeClickSubtypeProb(getModePerformance(30));
    expect(prob).toBeGreaterThan(0.5);
    expect(prob).toBeLessThanOrEqual(0.7);
  });

  it('returns top bait replies ordered by score', async () => {
    await seedBaitReply('CLICKBAIT', 3);
    await seedBaitReply('RAGEBAIT', 30);

    const { getTopPerformingReplies } = await import('../../src/storage/engagement_performance.js');
    const top = getTopPerformingReplies(2, { baitOnly: true });
    expect(top.length).toBe(2);
    expect(top[0].mode).toBe('RAGEBAIT');
    expect(top[0].score).toBeGreaterThan(top[1].score);
  });
});

describe('engagement bait tuning helpers', () => {
  it('uses subtypeClickProb override in tests', async () => {
    const { decideEngagementBait } = await import('../../src/pipeline/engagement_bait.js');
    const result = decideEngagementBait({
      targetPct: 30,
      blocked: false,
      counts: { bait: 0, normal: 10 },
      rng: () => 0.85,
      subtypeClickProb: 0.9,
    });
    expect(result.mode).toBe('CLICKBAIT');
  });

  it('engagementScore matches analytics weighting', async () => {
    const { engagementScore } = await import('../../src/storage/engagement_performance.js');
    expect(engagementScore(10, 2, 1, 1000)).toBe(10 * 2 + 2 * 5 + 1 * 3 + 10);
  });
});
