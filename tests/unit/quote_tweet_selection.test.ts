import { describe, expect, it } from 'vitest';
import { rankQuoteTweetCandidates } from '../../src/context/trends.js';
import type { Post } from '../../src/storage/queries.js';

function makePost(id: string, text: string, timestamp: number, likes = 0): Post {
  return {
    id,
    tweet_id: id,
    author_handle: `${id}_author`,
    author_name: id,
    text,
    language: 'english',
    timestamp,
    likes,
    replies: 0,
    retweets: 0,
    tweet_url: `https://x.com/${id}_author/status/${id}`,
    status: 'INGESTED',
    score: null,
    score_breakdown: null,
    generated_reply: null,
    final_reply: null,
    posted_tweet_id: null,
    deleted_at: null,
    posting_attempts: 0,
    retry_after: null,
    last_error: null,
    ingested_at: timestamp,
    updated_at: timestamp,
  };
}

describe('quote tweet candidate ranking', () => {
  it('prefers a fresh post on a high-velocity topic', () => {
    const now = Math.floor(Date.now() / 1000);
    const ranked = rankQuoteTweetCandidates([
      makePost('1111111111111111', 'Pune Metro added a new service today.', now - 600, 4),
      makePost('2222222222222222', 'A generic Pune cafe observation.', now - 300, 20),
    ], [
      { topic: 'metro', last6h: 8, last24h: 10, velocity: 2.4 },
    ], now);

    expect(ranked[0].post.id).toBe('1111111111111111');
    expect(ranked[0].matchedTopics).toContain('metro');
    expect(ranked[0].velocity).toBe(2.4);
  });
});
