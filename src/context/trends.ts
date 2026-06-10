import { getDb } from '../storage/db.js';
import { Post } from '../storage/queries.js';
import { detectTopics } from './topics.js';

export interface TopicVelocity {
  topic: string;
  last6h: number;
  last24h: number;
  velocity: number;          // (last6h+1) / (last24h/4 + 1) — > 1 = trending
}

export interface QuoteTweetCandidate {
  post: Post;
  matchedTopics: string[];
  velocity: number;
  selectionScore: number;
}

/**
 * Compute trend velocity per topic from context_items.topics.
 *
 * Each item carries a JSON array of topic strings. We approximate "is this
 * topic getting more reporting recently than usual?" with a 6h vs prior-24h
 * comparison. A velocity > 1 means the last 6h share is higher than its
 * proportional share of the last 24h.
 */
export function getTopicVelocities(): TopicVelocity[] {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const cutoff6h = now - 6 * 3600;
  const cutoff24h = now - 24 * 3600;

  // Pull topic JSON arrays from items in the last 24h, then aggregate in JS.
  const rows = db.prepare(`
    SELECT topics, COALESCE(published_at, fetched_at) AS ts
    FROM context_items
    WHERE COALESCE(published_at, fetched_at) >= ?
  `).all(cutoff24h) as Array<{ topics: string; ts: number }>;

  const last6h = new Map<string, number>();
  const last24h = new Map<string, number>();

  for (const row of rows) {
    let arr: string[] = [];
    try {
      arr = JSON.parse(row.topics) as string[];
    } catch {
      continue;
    }
    for (const t of arr) {
      last24h.set(t, (last24h.get(t) ?? 0) + 1);
      if (row.ts >= cutoff6h) last6h.set(t, (last6h.get(t) ?? 0) + 1);
    }
  }

  const topics = new Set([...last24h.keys(), ...last6h.keys()]);
  const out: TopicVelocity[] = [];
  for (const topic of topics) {
    const a = last6h.get(topic) ?? 0;
    const b = last24h.get(topic) ?? 0;
    const velocity = (a + 1) / (b / 4 + 1);
    out.push({ topic, last6h: a, last24h: b, velocity });
  }
  out.sort((x, y) => y.velocity - x.velocity);
  return out;
}

/** Map of topic → velocity for quick lookup in pickTopic. */
export function getVelocityMap(): Map<string, number> {
  return new Map(getTopicVelocities().map((v) => [v.topic, v.velocity]));
}

export function selectQuoteTweetCandidate(): QuoteTweetCandidate | null {
  const now = Math.floor(Date.now() / 1000);
  const rows = getDb().prepare(`
    SELECT p.* FROM posts p
    WHERE p.timestamp >= ?
      AND p.tweet_url <> ''
      AND NOT EXISTS (
        SELECT 1 FROM original_posts op
        WHERE op.quoted_tweet_id = p.tweet_id
      )
    ORDER BY p.timestamp DESC
    LIMIT 100
  `).all(now - 24 * 3600) as Post[];

  const ownHandle = process.env.X_HANDLE?.replace(/^@/, '').toLowerCase();
  const eligible = ownHandle
    ? rows.filter((post) => post.author_handle.replace(/^@/, '').toLowerCase() !== ownHandle)
    : rows;
  return rankQuoteTweetCandidates(eligible, getTopicVelocities(), now)[0] ?? null;
}

export function rankQuoteTweetCandidates(
  posts: Post[],
  velocities: TopicVelocity[],
  nowSec = Math.floor(Date.now() / 1000),
): QuoteTweetCandidate[] {
  const velocityMap = new Map(velocities.map((item) => [item.topic, item.velocity]));

  return posts.map((post) => {
    const matchedTopics = detectTopics(post.text);
    const velocity = Math.max(1, ...matchedTopics.map((topic) => velocityMap.get(topic) ?? 1));
    const ageHours = Math.max(0, (nowSec - post.timestamp) / 3600);
    const recency = Math.max(0.15, 1 - ageHours / 24);
    const engagement = Math.log1p(post.likes + post.replies * 3 + post.retweets * 2);
    const selectionScore = velocity * 4 + recency * 4 + engagement;
    return {
      post,
      matchedTopics,
      velocity,
      selectionScore: Math.round(selectionScore * 100) / 100,
    };
  }).sort((a, b) => b.selectionScore - a.selectionScore);
}
