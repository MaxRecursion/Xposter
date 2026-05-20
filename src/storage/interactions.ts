import { getDb } from './db.js';

export interface Interaction {
  id: number;
  post_id: string;
  account_handle: string;
  our_reply_text: string;
  our_tweet_id: string | null;
  our_tweet_url: string | null;
  posted_at: number;
  likes_received: number;
  replies_received: number;
  retweets_received: number;
  impressions: number;
  last_metric_check: number | null;
  success_score: number;
  author_engaged: number;
  notes: string | null;
}

export function recordInteraction(
  postId: string,
  accountHandle: string,
  replyText: string,
  posted: { tweetId?: string; tweetUrl?: string } = {},
): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO interactions (
      post_id, account_handle, our_reply_text, our_tweet_id, our_tweet_url
    ) VALUES (?, ?, ?, ?, ?)
  `).run(postId, accountHandle, replyText, posted.tweetId ?? null, posted.tweetUrl ?? null);

  db.prepare(`
    INSERT INTO accounts (handle, total_replies_sent, last_seen_at, updated_at)
    VALUES (?, 1, unixepoch(), unixepoch())
    ON CONFLICT(handle) DO UPDATE SET
      total_replies_sent = accounts.total_replies_sent + 1,
      last_seen_at       = unixepoch(),
      updated_at         = unixepoch()
  `).run(accountHandle);

  return result.lastInsertRowid as number;
}

export function updateInteractionMetrics(
  id: number,
  metrics: {
    likes?: number;
    replies?: number;
    retweets?: number;
    impressions?: number;
    authorEngaged?: boolean;
  },
): void {
  const successScore =
    (metrics.likes ?? 0) * 1 +
    (metrics.replies ?? 0) * 13 +
    (metrics.retweets ?? 0) * 20 +
    (metrics.authorEngaged ? 25 : 0);

  getDb().prepare(`
    UPDATE interactions SET
      likes_received    = COALESCE(?, likes_received),
      replies_received  = COALESCE(?, replies_received),
      retweets_received = COALESCE(?, retweets_received),
      impressions       = COALESCE(?, impressions),
      author_engaged    = COALESCE(?, author_engaged),
      last_metric_check = unixepoch(),
      success_score     = ?
    WHERE id = ?
  `).run(
    metrics.likes ?? null,
    metrics.replies ?? null,
    metrics.retweets ?? null,
    metrics.impressions ?? null,
    metrics.authorEngaged === undefined ? null : (metrics.authorEngaged ? 1 : 0),
    successScore,
    id,
  );
}

export function listRecentInteractions(limit = 50): Interaction[] {
  return getDb()
    .prepare(`SELECT * FROM interactions ORDER BY posted_at DESC LIMIT ?`)
    .all(Math.min(Math.max(limit, 1), 500)) as Interaction[];
}

export function getInteractionStats(): {
  total: number;
  total_likes: number;
  total_replies: number;
  total_retweets: number;
  avg_success: number;
} {
  return getDb().prepare(`
    SELECT
      COUNT(*)                           AS total,
      COALESCE(SUM(likes_received),0)    AS total_likes,
      COALESCE(SUM(replies_received),0)  AS total_replies,
      COALESCE(SUM(retweets_received),0) AS total_retweets,
      COALESCE(AVG(success_score),0)     AS avg_success
    FROM interactions
  `).get() as {
    total: number;
    total_likes: number;
    total_replies: number;
    total_retweets: number;
    avg_success: number;
  };
}
