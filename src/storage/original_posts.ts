import crypto from 'crypto';
import { getDb } from './db.js';

export type OriginalPostStatus = 'GENERATING' | 'POSTED' | 'ERROR' | 'SKIPPED';

export interface OriginalPost {
  id: string;
  content: string;
  language: string;
  topic: string;
  status: OriginalPostStatus;
  tweet_id: string | null;
  tweet_url: string | null;
  research_context: string | null;
  posted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PostImpression {
  id: number;
  original_post_id: string;
  tweet_id: string;
  impressions: number;
  likes: number;
  replies: number;
  retweets: number;
  checked_at: number;
}

export interface TopicPerformance {
  topic: string;
  total_posts: number;
  avg_likes: number;
  avg_replies: number;
  avg_retweets: number;
  avg_impressions: number;
  engagement_score: number;
}

// ── Insert ────────────────────────────────────────────────────────────────────

export function insertOriginalPost(data: {
  content: string;
  language: string;
  topic: string;
  researchContext?: string;
}): OriginalPost {
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO original_posts (id, content, language, topic, research_context)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, data.content, data.language, data.topic, data.researchContext ?? null);
  return getOriginalPost(id)!;
}

export function insertImpression(data: {
  originalPostId: string;
  tweetId: string;
  impressions: number;
  likes: number;
  replies: number;
  retweets: number;
}): void {
  getDb().prepare(`
    INSERT INTO post_impressions
      (original_post_id, tweet_id, impressions, likes, replies, retweets)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    data.originalPostId, data.tweetId,
    data.impressions, data.likes, data.replies, data.retweets,
  );
}

// ── Update ────────────────────────────────────────────────────────────────────

export function markOriginalPostPosted(
  id: string,
  tweetId: string | null,
  tweetUrl: string | null,
): void {
  getDb().prepare(`
    UPDATE original_posts
    SET status = 'POSTED', tweet_id = ?, tweet_url = ?,
        posted_at = unixepoch(), updated_at = unixepoch()
    WHERE id = ?
  `).run(tweetId, tweetUrl, id);
}

export function markOriginalPostError(id: string): void {
  getDb().prepare(`
    UPDATE original_posts
    SET status = 'ERROR', updated_at = unixepoch()
    WHERE id = ?
  `).run(id);
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function getOriginalPost(id: string): OriginalPost | null {
  return (getDb()
    .prepare('SELECT * FROM original_posts WHERE id = ?')
    .get(id) as OriginalPost | undefined) ?? null;
}

export function listOriginalPosts(limit = 50): OriginalPost[] {
  return getDb()
    .prepare('SELECT * FROM original_posts ORDER BY created_at DESC LIMIT ?')
    .all(Math.min(limit, 500)) as OriginalPost[];
}

/** Posts that have been published and need impression checking (no check in the last N hours). */
export function getPostsNeedingImpressionSync(olderThanSeconds = 7200): OriginalPost[] {
  const db = getDb();
  return db.prepare(`
    SELECT op.* FROM original_posts op
    WHERE op.status = 'POSTED'
      AND op.tweet_id IS NOT NULL
      AND (
        NOT EXISTS (
          SELECT 1 FROM post_impressions pi
          WHERE pi.original_post_id = op.id
        )
        OR (
          SELECT MAX(pi.checked_at) FROM post_impressions pi
          WHERE pi.original_post_id = op.id
        ) < unixepoch() - ?
      )
    ORDER BY op.posted_at DESC
    LIMIT 20
  `).all(olderThanSeconds) as OriginalPost[];
}

export function getLatestImpression(originalPostId: string): PostImpression | null {
  return (getDb()
    .prepare(`
      SELECT * FROM post_impressions
      WHERE original_post_id = ?
      ORDER BY checked_at DESC LIMIT 1
    `)
    .get(originalPostId) as PostImpression | undefined) ?? null;
}

/** Per-topic performance aggregated across all posted original posts. */
export function getTopicPerformance(): TopicPerformance[] {
  return getDb().prepare(`
    SELECT
      op.topic,
      COUNT(DISTINCT op.id)           AS total_posts,
      COALESCE(AVG(pi.likes),0)       AS avg_likes,
      COALESCE(AVG(pi.replies),0)     AS avg_replies,
      COALESCE(AVG(pi.retweets),0)    AS avg_retweets,
      COALESCE(AVG(pi.impressions),0) AS avg_impressions,
      COALESCE(
        AVG(pi.likes * 2 + pi.replies * 5 + pi.retweets * 3 + pi.impressions * 0.01),
        0
      ) AS engagement_score
    FROM original_posts op
    LEFT JOIN post_impressions pi ON pi.original_post_id = op.id
    WHERE op.status = 'POSTED'
    GROUP BY op.topic
    ORDER BY engagement_score DESC
  `).all() as TopicPerformance[];
}

/** Latest impression per post, joined with post metadata — for the dashboard. */
export function listOriginalPostsWithImpressions(limit = 50): Array<OriginalPost & {
  latest_impressions: number;
  latest_likes: number;
  latest_replies: number;
  latest_retweets: number;
}> {
  return getDb().prepare(`
    SELECT
      op.*,
      COALESCE(pi.impressions, 0) AS latest_impressions,
      COALESCE(pi.likes, 0)       AS latest_likes,
      COALESCE(pi.replies, 0)     AS latest_replies,
      COALESCE(pi.retweets, 0)    AS latest_retweets
    FROM original_posts op
    LEFT JOIN post_impressions pi ON pi.id = (
      SELECT id FROM post_impressions
      WHERE original_post_id = op.id
      ORDER BY checked_at DESC LIMIT 1
    )
    ORDER BY op.created_at DESC
    LIMIT ?
  `).all(Math.min(limit, 500)) as any[];
}
