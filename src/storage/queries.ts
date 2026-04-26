import { getDb } from './db.js';
import crypto from 'crypto';
import { isValidTweetReference } from '../utils/x.js';

export type PostStatus =
  | 'INGESTED' | 'FILTERED' | 'SCORED' | 'GENERATING'
  | 'PENDING_APPROVAL' | 'APPROVED' | 'POSTING'
  | 'POSTED' | 'SKIPPED' | 'EXPIRED' | 'ERROR';

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

// ── Insert ────────────────────────────────────────────────────────────────────

export function upsertPost(tweet: RawTweet): Post | null {
  if (!isValidTweetReference(tweet.tweet_id, tweet.tweet_url)) {
    return null;
  }

  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM posts WHERE tweet_id = ?')
    .get(tweet.tweet_id) as { id: string } | undefined;

  if (existing) return null;

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO posts (id, tweet_id, author_handle, author_name, text,
      timestamp, likes, replies, retweets, tweet_url, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INGESTED')
  `).run(
    id, tweet.tweet_id, tweet.author_handle, tweet.author_name,
    tweet.text, tweet.timestamp, tweet.likes, tweet.replies,
    tweet.retweets, tweet.tweet_url,
  );

  return getPost(id)!;
}

// ── Read ──────────────────────────────────────────────────────────────────────

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

// ── Update ────────────────────────────────────────────────────────────────────

export function updatePostStatus(id: string, status: PostStatus): void {
  getDb()
    .prepare(`UPDATE posts SET status = ?, updated_at = unixepoch() WHERE id = ?`)
    .run(status, id);
}

export function updatePostLanguage(id: string, language: string): void {
  getDb()
    .prepare(`UPDATE posts SET language = ?, status = 'FILTERED', updated_at = unixepoch() WHERE id = ?`)
    .run(language, id);
}

export function updatePostScore(
  id: string,
  score: number,
  breakdown: Record<string, number>,
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

// ── Activity Log ──────────────────────────────────────────────────────────────

export function logEvent(
  event: string,
  detail?: string,
  postId?: string,
): void {
  getDb()
    .prepare(`INSERT INTO activity_log (post_id, event, detail) VALUES (?, ?, ?)`)
    .run(postId ?? null, event, detail ?? null);
}

export function getActivityLog(limit = 100): Array<{
  id: number; post_id: string | null; event: string; detail: string | null; created_at: number;
}> {
  return getDb()
    .prepare(`SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as any[];
}

// ── Settings ──────────────────────────────────────────────────────────────────

export function getSetting(key: string, fallback: string): string {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)')
    .run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT key, value FROM settings')
    .all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ── Expire stale pending posts ────────────────────────────────────────────────

export function expireOldPending(): number {
  const timeoutMin = parseInt(getSetting('approval_timeout_min', '30'), 10);
  const cutoff = Math.floor(Date.now() / 1000) - timeoutMin * 60;
  const result = getDb().prepare(`
    UPDATE posts
    SET status = 'EXPIRED', updated_at = unixepoch()
    WHERE status = 'PENDING_APPROVAL' AND updated_at < ?
  `).run(cutoff);
  return result.changes;
}
