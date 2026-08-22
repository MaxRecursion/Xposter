import { describe, it, expect } from 'vitest';
import {
  crowdingFactor, heatFactor, likesPerMinute, readVelocity, roundVelocityRead, windowFactor,
  type VelocityConfig,
} from '../../src/pipeline/velocity.js';
import { scorePost } from '../../src/pipeline/scorer.js';

const CFG: VelocityConfig = { strikeWindowMin: 25, minLikesPerMin: 0.3 };

describe('likesPerMinute', () => {
  it('is zero for a tweet with no likes', () => {
    expect(likesPerMinute(0, 10)).toBe(0);
  });

  it('computes the cumulative like rate', () => {
    expect(likesPerMinute(100, 10)).toBe(10);
  });

  it('damps very young tweets so one like does not read as a rocket', () => {
    // 1 like at 1 minute would be 1.0 lpm unfloored; the 3-minute floor
    // keeps noise from outranking genuinely moving tweets.
    expect(likesPerMinute(1, 1)).toBeCloseTo(1 / 3, 5);
    expect(likesPerMinute(1, 1)).toBeLessThan(likesPerMinute(30, 3));
  });

  it('ignores negative and non-finite inputs', () => {
    expect(likesPerMinute(-5, 10)).toBe(0);
    expect(likesPerMinute(Number.NaN, 10)).toBe(0);
  });
});

describe('windowFactor', () => {
  it('gives only partial credit to a tweet too young to have proved itself', () => {
    expect(windowFactor(1, 25)).toBe(0.4);
    expect(windowFactor(1, 25)).toBeLessThan(windowFactor(10, 25));
  });

  it('gives full credit across the strike window', () => {
    expect(windowFactor(3, 25)).toBe(1);
    expect(windowFactor(25, 25)).toBe(1);
  });

  it('steps down after the window rather than cliff-edging to zero', () => {
    expect(windowFactor(60, 25)).toBe(0.5);
    expect(windowFactor(150, 25)).toBe(0.2);
    expect(windowFactor(600, 25)).toBe(0.05);
  });

  it('never returns zero, so a stale tweet stays rankable as a last resort', () => {
    expect(windowFactor(10_000, 25)).toBeGreaterThan(0);
  });
});

describe('heatFactor', () => {
  it('is zero for a tweet gathering nothing', () => {
    expect(heatFactor(0, 0.3)).toBe(0);
  });

  it('increases monotonically with like-rate', () => {
    const rates = [0.1, 0.3, 1, 5, 50, 500];
    const values = rates.map((r) => heatFactor(r, 0.3));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  it('is log-scaled so a runaway tweet cannot dwarf every other term', () => {
    // A 100x rate difference must stay well under a 100x score difference,
    // otherwise one viral tweet makes the window and crowding terms irrelevant.
    const ratio = heatFactor(500, 0.3) / heatFactor(5, 0.3);
    expect(ratio).toBeLessThan(3);
  });

  it('still separates candidates below the configured floor', () => {
    // On a quiet timeline everything sits here; ties would collapse ranking.
    expect(heatFactor(0.2, 0.3)).toBeGreaterThan(heatFactor(0.05, 0.3));
  });

  it('never exceeds one', () => {
    expect(heatFactor(1e6, 0.3)).toBeLessThanOrEqual(1);
  });
});

describe('crowdingFactor', () => {
  it('is full credit on an empty thread', () => {
    expect(crowdingFactor(0)).toBe(1);
  });

  it('falls as the reply pile grows, bottoming out rather than zeroing', () => {
    expect(crowdingFactor(75)).toBeCloseTo(0.65, 5);
    expect(crowdingFactor(150)).toBeCloseTo(0.3, 5);
    expect(crowdingFactor(5000)).toBeCloseTo(0.3, 5);
  });

  it('never rewards an empty thread beyond full credit', () => {
    expect(crowdingFactor(0)).toBe(1);
    expect(crowdingFactor(1)).toBeLessThanOrEqual(1);
  });
});

describe('readVelocity', () => {
  const now = 1_700_000_000;
  const minsAgo = (m: number) => now - m * 60;

  it('marks a fresh, fast-moving tweet as in the strike window', () => {
    const v = readVelocity(200, minsAgo(10), now, CFG);
    expect(v.inStrikeWindow).toBe(true);
    expect(v.lpm).toBeCloseTo(20, 5);
    expect(v.reachFactor).toBeGreaterThan(1);
  });

  it('demotes a fresh but motionless tweet below a fresh moving one', () => {
    const dead = readVelocity(1, minsAgo(10), now, CFG);
    const alive = readVelocity(200, minsAgo(10), now, CFG);
    expect(dead.inStrikeWindow).toBe(false);
    expect(dead.reachFactor).toBeLessThan(alive.reachFactor);
  });

  it('demotes a once-popular tweet that is now old', () => {
    const stale = readVelocity(400, minsAgo(600), now, CFG);
    const fresh = readVelocity(400, minsAgo(15), now, CFG);
    expect(stale.inStrikeWindow).toBe(false);
    expect(stale.reachFactor).toBeLessThan(fresh.reachFactor);
  });

  it('demotes a tweet our reply would be buried under', () => {
    const open = readVelocity(300, minsAgo(12), now, CFG, 2);
    const buried = readVelocity(300, minsAgo(12), now, CFG, 4000);
    expect(buried.reachFactor).toBeLessThan(open.reachFactor);
  });

  it('does not treat a barely-posted tweet as a proven winner', () => {
    const unproven = readVelocity(5, minsAgo(1), now, CFG);
    const proven = readVelocity(120, minsAgo(12), now, CFG);
    expect(unproven.reachFactor).toBeLessThan(proven.reachFactor);
  });

  it('does not reward a dead tweet for having an empty reply thread', () => {
    // Regression: an untouched thread must not stand in for traction.
    const deadEmpty = readVelocity(0, minsAgo(1), now, CFG, 0);
    const aliveBusy = readVelocity(150, minsAgo(12), now, CFG, 40);
    expect(deadEmpty.reachFactor).toBeLessThan(aliveBusy.reachFactor);
    expect(deadEmpty.reachFactor).toBeLessThan(0.5);
  });

  it('ranks a fresh rocket above an older tweet with the same like count', () => {
    const fresh = readVelocity(150, minsAgo(8), now, CFG);
    const stale = readVelocity(150, minsAgo(240), now, CFG);
    expect(fresh.reachFactor).toBeGreaterThan(stale.reachFactor);
  });

  it('keeps the multiplier inside its documented bounds', () => {
    const cases = [
      readVelocity(0, minsAgo(1), now, CFG),
      readVelocity(50_000, minsAgo(1), now, CFG),
      readVelocity(3, minsAgo(5000), now, CFG),
    ];
    for (const v of cases) {
      expect(v.reachFactor).toBeGreaterThanOrEqual(0.15);
      expect(v.reachFactor).toBeLessThanOrEqual(1.4);
    }
  });

  it('treats a tweet dated in the future as brand new rather than erroring', () => {
    const v = readVelocity(10, now + 600, now, CFG);
    expect(v.ageMinutes).toBe(0);
    expect(Number.isFinite(v.reachFactor)).toBe(true);
  });
});

describe('roundVelocityRead', () => {
  it('rounds for compact storage in the score breakdown', () => {
    const v = readVelocity(200, 1_700_000_000 - 7 * 60, 1_700_000_000, CFG);
    const { velocityLpm, reachFactor } = roundVelocityRead(v);
    expect(velocityLpm).toBeCloseTo(28.57, 2);
    expect(String(reachFactor).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3);
  });
});

describe('scorePost reach multiplier', () => {
  const now = Math.floor(Date.now() / 1000);

  // Cast rather than spell out every column: the Post shape is actively
  // growing (tournament metadata), and scoring only reads these fields.
  const makePost = (over: Record<string, unknown>) => ({
    id: 'p', tweet_id: '1', author_handle: 'a', author_name: 'A',
    text: 'Heavy rain in Pune today, anyone know about flooding near Swargate?',
    language: 'english', timestamp: now - 600, likes: 5, replies: 2, retweets: 1,
    tweet_url: 'https://x.com/a/status/1', status: 'SCORED',
    score: null, score_breakdown: null, generated_reply: null, final_reply: null,
    ingested_at: now, updated_at: now, ...over,
  }) as unknown as Parameters<typeof scorePost>[0];

  it('ranks a fresh fast tweet above an identical dead one', () => {
    const hot = scorePost(makePost({ id: 'hot', timestamp: now - 8 * 60, likes: 300 }));
    const dead = scorePost(makePost({ id: 'dead', timestamp: now - 8 * 60, likes: 0 }));

    // The gate score is deliberately untouched; reach decides the ordering.
    expect(hot.reachScore).toBeGreaterThan(dead.reachScore);
    expect(hot.breakdown.reachFactor).toBeGreaterThan(dead.breakdown.reachFactor);
  });

  it('demotes a stale tweet even when it is highly topical', () => {
    // Same keyword-rich text; only age and rate differ.
    const fresh = scorePost(makePost({ id: 'f', timestamp: now - 5 * 60, likes: 200 }));
    const stale = scorePost(makePost({ id: 's', timestamp: now - 5 * 3600, likes: 200 }));

    expect(stale.reachScore).toBeLessThan(fresh.reachScore);
  });

  it('records the observed like rate on the breakdown', () => {
    const scored = scorePost(makePost({ timestamp: now - 10 * 60, likes: 100 }));
    expect(scored.breakdown.velocityLpm).toBeCloseTo(10, 1);
  });
});

describe('starvation safety', () => {
  const now = Math.floor(Date.now() / 1000);
  const makePost = (over: Record<string, unknown>) => ({
    id: 'p', tweet_id: '1', author_handle: 'a', author_name: 'A',
    text: 'Heavy rain in Pune today, anyone know about flooding near Swargate?',
    language: 'english', timestamp: now - 600, likes: 5, replies: 2, retweets: 1,
    tweet_url: 'https://x.com/a/status/1', status: 'SCORED',
    score: null, score_breakdown: null, generated_reply: null, final_reply: null,
    ingested_at: now, updated_at: now, ...over,
  }) as unknown as Parameters<typeof scorePost>[0];

  it('leaves the min_score gate untouched, however dead the tweet is', () => {
    // The whole pool sitting below min_score would drop the pipeline into
    // permanent fallback and quietly cut posting volume — the failure mode
    // this design exists to avoid.
    const lively = scorePost(makePost({ timestamp: now - 8 * 60, likes: 400 }));
    const corpse = scorePost(makePost({ timestamp: now - 20 * 3600, likes: 0 }));

    expect(corpse.score).toBeGreaterThan(0);
    // Same text and signals, so the gate score should not move with velocity.
    expect(Math.abs(lively.score - corpse.score)).toBeLessThan(35);
    expect(corpse.reachScore).toBeLessThan(lively.reachScore);
  });

  it('always produces a finite, ordered reachScore', () => {
    const posts = [
      makePost({ likes: 0, replies: 0, timestamp: now }),
      makePost({ likes: 1e6, replies: 1e5, timestamp: now - 60 }),
      makePost({ likes: 3, replies: 0, timestamp: now - 400 * 3600 }),
    ].map((p) => scorePost(p));

    for (const p of posts) {
      expect(Number.isFinite(p.reachScore)).toBe(true);
      expect(p.reachScore).toBeGreaterThanOrEqual(0);
    }
  });
});
