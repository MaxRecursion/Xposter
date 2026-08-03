import { getDb } from './db.js';
import crypto from 'crypto';
import { isValidTweetReference } from '../utils/x.js';
import { getIntSettingFromSchema } from './settings.js';

export type PostStatus =
  | 'INGESTED' | 'FILTERED' | 'SCORED' | 'GENERATING'
  | 'PENDING_APPROVAL' | 'APPROVED' | 'POSTING'
  | 'POSTED' | 'SKIPPED' | 'EXPIRED' | 'ERROR' | 'DELETED';

/** Where a reply candidate was discovered. */
export type PostSource = 'TIMELINE' | 'TREND_GLOBAL' | 'TREND_INDIA';

/** How a reply to this post should be framed. */
export type Stance = 'ALIGNED' | 'CONTRARIAN';

export interface Post {
  id: string;
  tweet_id: string;
  author_handle: string;
  author_name: string;
  text: string;
  language: string;
  timestamp: number;
  likes: number;
  replies: number;
  retweets: number;
  tweet_url: string;
  status: PostStatus;
  score: number | null;
  score_breakdown: string | null;
  generated_reply: string | null;
  final_reply: string | null;
  posted_tweet_id: string | null;
  source: PostSource;
  stance: Stance | null;
  trend_key: string | null;
  engagement_mode: string | null;
  deleted_at: number | null;
  posting_attempts: number;
  retry_after: number | null;
  last_error: string | null;
  ingested_at: number;
  updated_at: number;
}

export interface RawTweet {
  tweet_id: string;
  author_handle: string;
  author_name: string;
  text: string;
  timestamp: number;
  likes: number;
  replies: number;
  retweets: number;
  tweet_url: string;
}

export interface UpsertPostMeta {
  /** Defaults to TIMELINE so existing single-arg callers are unaffected. */
  source?: PostSource;
  trendKey?: string | null;
}

/** Inserts a newly-ingested tweet; returns null for duplicates or invalid refs. */
export function upsertPost(tweet: RawTweet, meta: UpsertPostMeta = {}): Post | null {
  if (!isValidTweetReference(tweet.tweet_id, tweet.tweet_url)) {
    return null;
  }

  const id = crypto.randomUUID();
  const result = getDb().prepare(`
    INSERT INTO posts (id, tweet_id, author_handle, author_name, text,
      timestamp, likes, replies, retweets, tweet_url, status, source, trend_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INGESTED', ?, ?)
    ON CONFLICT(tweet_id) DO NOTHING
  `).run(
    id, tweet.tweet_id, tweet.author_handle, tweet.author_name,
    tweet.text, tweet.timestamp, tweet.likes, tweet.replies,
    tweet.retweets, tweet.tweet_url,
    meta.source ?? 'TIMELINE', meta.trendKey ?? null,
  );

  if (result.changes === 0) return null;
  return getPost(id)!;
}

export function getPost(id: string): Post | null {
  return (getDb()
    .prepare('SELECT * FROM posts WHERE id = ?')
    .get(id) as Post | undefined) ?? null;
}

export function getPostByTweetId(tweetId: string): Post | null {
  return (getDb()
    .prepare('SELECT * FROM posts WHERE tweet_id = ?')
    .get(tweetId) as Post | undefined) ?? null;
}

export function getPostsByStatus(status: PostStatus): Post[] {
  return getDb()
    .prepare('SELECT * FROM posts WHERE status = ? ORDER BY ingested_at DESC')
    .all(status) as Post[];
}

export function getPendingApproval(): Post[] {
  return getDb()
    .prepare(`SELECT * FROM posts WHERE status = 'PENDING_APPROVAL' ORDER BY score DESC`)
    .all() as Post[];
}

export function getRecentPosts(limitHours = 24): Post[] {
  const since = Math.floor(Date.now() / 1000) - limitHours * 3600;
  return getDb()
    .prepare(`SELECT * FROM posts WHERE ingested_at >= ? ORDER BY ingested_at DESC LIMIT 200`)
    .all(since) as Post[];
}

export function getDashboardStats(): Record<string, number> {
  const db = getDb();
  const rows = db
    .prepare(`SELECT status, COUNT(*) as cnt FROM posts GROUP BY status`)
    .all() as Array<{ status: string; cnt: number }>;

  return Object.fromEntries(rows.map((r) => [r.status, r.cnt]));
}

export function updatePostStatus(id: string, status: PostStatus): void {
  getDb()
    .prepare(`UPDATE posts SET status = ?, updated_at = unixepoch() WHERE id = ?`)
    .run(status, id);
}

export function claimPostForPosting(id: string): boolean {
  const result = getDb().prepare(`
    UPDATE posts SET status = 'POSTING', updated_at = unixepoch()
    WHERE id = ? AND status = 'PENDING_APPROVAL'
  `).run(id);
  return result.changes > 0;
}

export function updatePostLanguage(id: string, language: string): void {
  getDb()
    .prepare(`UPDATE posts SET language = ?, status = 'FILTERED', updated_at = unixepoch() WHERE id = ?`)
    .run(language, id);
}

export function updatePostStance(id: string, stance: Stance): void {
  getDb()
    .prepare(`UPDATE posts SET stance = ?, updated_at = unixepoch() WHERE id = ?`)
    .run(stance, id);
}

export function updatePostEngagementMode(id: string, mode: string): void {
  getDb()
    .prepare(`UPDATE posts SET engagement_mode = ?, updated_at = unixepoch() WHERE id = ?`)
    .run(mode, id);
}

export function updatePostScore(
  id: string,
  score: number,
  breakdown: object,
): void {
  getDb().prepare(`
    UPDATE posts
    SET score = ?, score_breakdown = ?, status = 'SCORED', updated_at = unixepoch()
    WHERE id = ?
  `).run(score, JSON.stringify(breakdown), id);
}

export function updateGeneratedReply(id: string, reply: string): void {
  getDb().prepare(`
    UPDATE posts
    SET generated_reply = ?, final_reply = ?, status = 'PENDING_APPROVAL', updated_at = unixepoch()
    WHERE id = ?
  `).run(reply, reply, id);
}

export function updateFinalReply(id: string, reply: string): void {
  getDb().prepare(`UPDATE posts SET final_reply = ?, updated_at = unixepoch() WHERE id = ?`)
    .run(reply, id);
}

export function updatePostedTweetId(id: string, postedTweetId: string): void {
  getDb()
    .prepare(`UPDATE posts SET posted_tweet_id = ?, updated_at = unixepoch() WHERE id = ?`)
    .run(postedTweetId, id);
}

export function getPostByPostedTweetId(postedTweetId: string): Post | null {
  return (getDb()
    .prepare('SELECT * FROM posts WHERE posted_tweet_id = ?')
    .get(postedTweetId) as Post | undefined) ?? null;
}

export function getLastPostedUnix(): number {
  const row = getDb()
    .prepare(`SELECT updated_at FROM posts WHERE status = 'POSTED' ORDER BY updated_at DESC LIMIT 1`)
    .get() as { updated_at: number } | undefined;
  return row?.updated_at ?? 0;
}

export function markReplyDeleted(id: string): void {
  const db = getDb();
  db.pragma('ignore_check_constraints = ON');
  try {
    db.prepare(
      `UPDATE posts SET status = 'DELETED', deleted_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`,
    ).run(id);
  } finally {
    db.pragma('ignore_check_constraints = OFF');
  }
}

export function markPostAsPosted(id: string, postedTweetId: string | null): void {
  getDb().prepare(`
    UPDATE posts
    SET status = 'POSTED', posted_tweet_id = ?, retry_after = NULL,
        last_error = NULL, updated_at = unixepoch()
    WHERE id = ?
  `).run(postedTweetId, id);
}

export const MAX_POSTING_ATTEMPTS = 2;

export function incrementPostingAttempt(id: string): number {
  const db = getDb();
  db.prepare(`
    UPDATE posts
    SET posting_attempts = posting_attempts + 1, updated_at = unixepoch()
    WHERE id = ?
  `).run(id);
  return (db.prepare('SELECT posting_attempts FROM posts WHERE id = ?').get(id) as {
    posting_attempts: number;
  } | undefined)?.posting_attempts ?? 0;
}

export function schedulePostRetry(id: string, error: string): void {
  getDb().prepare(`
    UPDATE posts
    SET status = 'ERROR', retry_after = unixepoch(), last_error = ?, updated_at = unixepoch()
    WHERE id = ?
  `).run(error.slice(0, 1000), id);
}

export function markPostPostingError(id: string, error: string): void {
  getDb().prepare(`
    UPDATE posts
    SET status = 'ERROR', retry_after = NULL, last_error = ?, updated_at = unixepoch()
    WHERE id = ?
  `).run(error.slice(0, 1000), id);
}

export function getPostsDueForRetry(limit = 3): Post[] {
  return getDb().prepare(`
    SELECT * FROM posts
    WHERE status = 'ERROR'
      AND retry_after IS NOT NULL
      AND retry_after <= unixepoch()
      AND posting_attempts < ?
      AND final_reply IS NOT NULL
    ORDER BY retry_after, updated_at
    LIMIT ?
  `).all(MAX_POSTING_ATTEMPTS, Math.min(Math.max(limit, 1), 10)) as Post[];
}

export function claimPostRetry(id: string): boolean {
  const result = getDb().prepare(`
    UPDATE posts
    SET status = 'POSTING', posting_attempts = posting_attempts + 1,
        retry_after = NULL, updated_at = unixepoch()
    WHERE id = ?
      AND status = 'ERROR'
      AND retry_after IS NOT NULL
      AND retry_after <= unixepoch()
      AND posting_attempts < ?
  `).run(id, MAX_POSTING_ATTEMPTS);
  return result.changes > 0;
}

export function expireOldPending(): number {
  const timeoutMin = getIntSettingFromSchema('approval_timeout_min');
  const cutoff = Math.floor(Date.now() / 1000) - timeoutMin * 60;
  const result = getDb().prepare(`
    UPDATE posts
    SET status = 'EXPIRED', updated_at = unixepoch()
    WHERE status = 'PENDING_APPROVAL' AND updated_at < ?
  `).run(cutoff);
  return result.changes;
}
