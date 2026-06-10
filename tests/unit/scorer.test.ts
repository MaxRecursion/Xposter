import { describe, it, expect, beforeEach } from 'vitest';
import {
  accountHistorySignal, rankCandidates, scorePost, topicalHeatSignal,
} from '../../src/pipeline/scorer.js';
import type { Post } from '../../src/storage/queries.js';

function makePost(overrides: Partial<Post> = {}): Post {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'test-id',
    tweet_id: '12345',
    author_handle: 'testuser',
    author_name: 'Test User',
    text: 'Heavy rain in Pune today, anyone know about flooding near Swargate?',
    language: 'english',
    timestamp: now - 600,     // 10 minutes ago
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
  };
}

describe('scorePost', () => {
  it('returns score in 0–100 range', () => {
    const { score } = scorePost(makePost());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('scores recent posts higher than old posts', () => {
    const now = Math.floor(Date.now() / 1000);
    const recent = scorePost(makePost({ timestamp: now - 300 }));    // 5 min
    const old    = scorePost(makePost({ timestamp: now - 20000 }));  // 5.5 hrs
    expect(recent.score).toBeGreaterThan(old.score);
  });

  it('scores posts with questions higher (reply opportunity)', () => {
    const withQ    = scorePost(makePost({ text: 'Pune traffic jam on Baner road — any alternate route?' }));
    const withoutQ = scorePost(makePost({ text: 'Nice weather in Pune today' }));
    expect(withQ.score).toBeGreaterThan(withoutQ.score);
  });

  it('scores topic-relevant posts higher', () => {
    const relevant = scorePost(makePost({
      text: 'Massive flooding near Swargate Pune, waterlogging everywhere potholes rain',
    }));
    const irrelevant = scorePost(makePost({ text: 'Went to a nice cafe in Pune' }));
    expect(relevant.score).toBeGreaterThan(irrelevant.score);
  });

  it('gives lower engagement-sweet score to viral posts', () => {
    const viral  = scorePost(makePost({ likes: 10000, retweets: 5000 }));
    const normal = scorePost(makePost({ likes: 10, retweets: 2 }));
    expect(normal.breakdown.engagementSweet).toBeGreaterThan(viral.breakdown.engagementSweet);
  });

  it('returns breakdown with all components', () => {
    const { breakdown } = scorePost(makePost());
    expect(breakdown).toHaveProperty('recency');
    expect(breakdown).toHaveProperty('topicRelevance');
    expect(breakdown).toHaveProperty('replyOpportunity');
    expect(breakdown).toHaveProperty('engagementSweet');
    expect(breakdown).toHaveProperty('topicalHeat');
    expect(breakdown).toHaveProperty('accountHistory');
  });

  it('adds topical heat and successful-author history to the score', () => {
    const baseline = scorePost(makePost());
    const boosted = scorePost(makePost(), { topicalHeat: 8, accountHistory: 7 });

    expect(boosted.score).toBeGreaterThan(baseline.score);
    expect(boosted.breakdown.topicalHeat).toBe(8);
    expect(boosted.breakdown.accountHistory).toBe(7);
  });
});

describe('dynamic scoring signals', () => {
  it('maps a close credible context hit to a strong topical boost', () => {
    const boost = topicalHeatSignal([{
      itemId: 'ctx-1',
      source: 'rss:test',
      sourceUrl: null,
      title: 'Pune flooding',
      body: 'Heavy rain and waterlogging across Pune.',
      language: 'english',
      topics: '[]',
      publishedAt: Math.floor(Date.now() / 1000),
      fetchedAt: Math.floor(Date.now() / 1000),
      credibility: 0.9,
      distance: 0.1,
    }]);
    expect(boost).toBeGreaterThan(7);
  });

  it('boosts authors with successful replies and demotes repeated non-engagers', () => {
    expect(accountHistorySignal({
      total_replies_sent: 5,
      successful_replies: 3,
      avg_reply_score: 20,
    })).toBeGreaterThan(5);
    expect(accountHistorySignal({
      total_replies_sent: 4,
      successful_replies: 0,
      avg_reply_score: 0,
    })).toBe(-6);
  });
});

describe('rankCandidates', () => {
  it('sorts by score descending', () => {
    const now = Math.floor(Date.now() / 1000);
    const a = scorePost(makePost({ id: 'a', timestamp: now - 100 }));
    const b = scorePost(makePost({ id: 'b', timestamp: now - 18000 }));
    const c = scorePost(makePost({ id: 'c', timestamp: now - 500 }));

    const ranked = rankCandidates([b, c, a]);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThanOrEqual(ranked[2].score);
  });

  it('handles empty array', () => {
    expect(rankCandidates([])).toEqual([]);
  });

  it('handles single element', () => {
    const now = Math.floor(Date.now() / 1000);
    const single = scorePost(makePost({ id: 'x', timestamp: now - 60 }));
    expect(rankCandidates([single])).toHaveLength(1);
  });
});
