import { describe, expect, it } from 'vitest';
import { scorePost, scoreTrendPost } from '../../src/pipeline/scorer.js';
import type { Post } from '../../src/storage/queries.js';

function makePost(overrides: Partial<Post> = {}): Post {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'test-id',
    tweet_id: '12345',
    author_handle: 'testuser',
    author_name: 'Test User',
    text: 'The new pricing changes everything for small teams.',
    language: 'english',
    timestamp: now - 3600,
    likes: 5,
    replies: 2,
    retweets: 1,
    tweet_url: 'https://x.com/testuser/status/12345',
    status: 'SCORED',
    score: null,
    score_breakdown: null,
    generated_reply: null,
    final_reply: null,
    ingested_at: now,
    updated_at: now,
    ...overrides,
  } as Post;
}

const minutesAgo = (m: number) => Math.floor(Date.now() / 1000) - m * 60;

describe('scoreTrendPost — reach', () => {
  it('prefers a viral post over a small one, inverting the timeline profile', () => {
    const viral = makePost({ id: 'viral', likes: 12000, retweets: 3000, replies: 400, timestamp: minutesAgo(60) });
    const small = makePost({ id: 'small', likes: 4, retweets: 0, replies: 1, timestamp: minutesAgo(60) });

    expect(scoreTrendPost(viral).score).toBeGreaterThan(scoreTrendPost(small).score);

    // The timeline scorer deliberately does the opposite: engagementSweet awards
    // 10 points for 1-50 engagement and 0 above 500. Asserting both directions
    // proves the two profiles are genuinely distinct and not accidentally aliased.
    const viralSweet = (scorePost(viral).breakdown as { engagementSweet: number }).engagementSweet;
    const smallSweet = (scorePost(small).breakdown as { engagementSweet: number }).engagementSweet;
    expect(smallSweet).toBeGreaterThan(viralSweet);
  });

  it('scales reach logarithmically so huge posts do not all saturate', () => {
    const big = scoreTrendPost(makePost({ likes: 10_000, timestamp: minutesAgo(60) }));
    const huge = scoreTrendPost(makePost({ likes: 100_000, timestamp: minutesAgo(60) }));
    const bigReach = (big.breakdown as unknown as { reach: number }).reach;
    const hugeReach = (huge.breakdown as unknown as { reach: number }).reach;
    expect(hugeReach).toBeGreaterThan(bigReach);
    expect(hugeReach).toBeLessThanOrEqual(30);
  });
});

describe('scoreTrendPost — velocity', () => {
  it('rewards the same engagement gathered faster', () => {
    const fast = scoreTrendPost(makePost({ id: 'fast', likes: 2000, timestamp: minutesAgo(40) }));
    const slow = scoreTrendPost(makePost({ id: 'slow', likes: 2000, timestamp: minutesAgo(60 * 24 * 3) }));
    expect(fast.score).toBeGreaterThan(slow.score);
  });
});

describe('scoreTrendPost — reply window', () => {
  const windowOf = (m: number) =>
    (scoreTrendPost(makePost({ timestamp: minutesAgo(m) })).breakdown as unknown as { replyWindow: number }).replyWindow;

  it('peaks inside the 10min-3h window', () => {
    expect(windowOf(45)).toBe(20);
    expect(windowOf(170)).toBe(20);
  });

  it('discounts posts too new to have proven traction', () => {
    expect(windowOf(3)).toBe(8);
  });

  it('decays through the afternoon and hits zero after 12h', () => {
    expect(windowOf(300)).toBe(10);
    expect(windowOf(600)).toBe(4);
    expect(windowOf(60 * 20)).toBe(0);
  });
});

describe('scoreTrendPost — crowding', () => {
  it('penalises a post already buried under thousands of replies', () => {
    const quiet = makePost({ id: 'quiet', likes: 5000, replies: 20, timestamp: minutesAgo(60) });
    const buried = makePost({ id: 'buried', likes: 5000, replies: 3000, timestamp: minutesAgo(60) });
    expect(scoreTrendPost(buried).score).toBeLessThan(scoreTrendPost(quiet).score);
  });

  it('floors the crowding penalty at -20', () => {
    const b = scoreTrendPost(makePost({ replies: 100_000 })).breakdown as unknown as { crowding: number };
    expect(b.crowding).toBe(-20);
  });
});

describe('scoreTrendPost — trend heat', () => {
  it('passes the trend-level signal through, clamped to 15', () => {
    const cold = scoreTrendPost(makePost(), { trendHeat: 0 });
    const hot = scoreTrendPost(makePost(), { trendHeat: 15 });
    expect(hot.score).toBeGreaterThan(cold.score);
    expect((scoreTrendPost(makePost(), { trendHeat: 99 }).breakdown as unknown as { trendHeat: number }).trendHeat).toBe(15);
  });
});

describe('scoreTrendPost — bounds', () => {
  it('stays within 0-100 for extreme inputs', () => {
    const max = scoreTrendPost(
      makePost({ likes: 5_000_000, retweets: 1_000_000, replies: 0, timestamp: minutesAgo(30) }),
      { trendHeat: 15, accountHistory: 10 },
    );
    expect(max.score).toBeLessThanOrEqual(100);

    const min = scoreTrendPost(
      makePost({ likes: 0, retweets: 0, replies: 50_000, timestamp: minutesAgo(60 * 100) }),
      { accountHistory: -6 },
    );
    expect(min.score).toBeGreaterThanOrEqual(0);
  });
});
