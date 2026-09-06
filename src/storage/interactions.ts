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
  content_structure: string | null;
  notes: string | null;
  judge_score: number | null;
  judge_reasoning: string | null;
  judge_evaluated_at: number | null;
}

export function recordInteraction(
  postId: string,
  accountHandle: string,
  replyText: string,
  posted: { tweetId?: string; tweetUrl?: string; contentStructure?: string } = {},
): number {
  const db = getDb();

  // Upsert the account first — interactions.account_handle has a FK on
  // accounts(handle), so the insert below fails for a never-seen account.
  db.prepare(`
    INSERT INTO accounts (handle, total_replies_sent, last_seen_at, updated_at)
    VALUES (?, 1, unixepoch(), unixepoch())
    ON CONFLICT(handle) DO UPDATE SET
      total_replies_sent = accounts.total_replies_sent + 1,
      last_seen_at       = unixepoch(),
      updated_at         = unixepoch()
  `).run(accountHandle);

  const result = db.prepare(`
    INSERT INTO interactions (
      post_id, account_handle, our_reply_text, our_tweet_id, our_tweet_url, content_structure
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    postId,
    accountHandle,
    replyText,
    posted.tweetId ?? null,
    posted.tweetUrl ?? null,
    posted.contentStructure ?? null,
  );

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

/**
 * Replies that have a captured tweet id and are due for an engagement check:
 * posted within the recency window and not checked in the last
 * `olderThanSeconds`. Newest first so fresh replies get tracked promptly.
 */
export function getInteractionsNeedingMetricSync(opts: {
  olderThanSeconds: number;
  postedWithinSeconds: number;
  limit: number;
}): Interaction[] {
  const now = Math.floor(Date.now() / 1000);
  return getDb().prepare(`
    SELECT * FROM interactions
    WHERE our_tweet_id IS NOT NULL
      AND posted_at >= ?
      AND COALESCE(last_metric_check, 0) <= ?
    ORDER BY posted_at DESC
    LIMIT ?
  `).all(
    now - opts.postedWithinSeconds,
    now - opts.olderThanSeconds,
    Math.min(Math.max(opts.limit, 1), 100),
  ) as Interaction[];
}

/**
 * Interactions eligible for LLM-judge evaluation: metric-synced (so the judge
 * always has a real posted reply to look at, not one that never went out) and
 * not yet judged. Oldest first so the backlog drains in posting order.
 */
export function getUnjudgedInteractions(limit = 10): Interaction[] {
  return getDb().prepare(`
    SELECT * FROM interactions
    WHERE last_metric_check IS NOT NULL
      AND judge_evaluated_at IS NULL
    ORDER BY posted_at ASC
    LIMIT ?
  `).all(Math.min(Math.max(limit, 1), 100)) as Interaction[];
}

export function updateJudgeScore(id: number, result: { score: number; reasoning: string }): void {
  getDb().prepare(`
    UPDATE interactions SET
      judge_score        = ?,
      judge_reasoning    = ?,
      judge_evaluated_at = unixepoch()
    WHERE id = ?
  `).run(result.score, result.reasoning, id);
}

// A reply counts as "successful" once it has meaningful engagement:
// success_score = likes + replies*13 + retweets*20, so 5 ≈ several likes
// or any reply/retweet.
const SUCCESSFUL_REPLY_MIN_SCORE = 5;

/**
 * Recompute an account's aggregate reply-performance stats from its
 * interactions. Called after a metric sync so the scorer can favor authors
 * who actually engage with our replies.
 */
export function refreshAccountReplyStats(accountHandle: string): void {
  getDb().prepare(`
    UPDATE accounts SET
      total_engagement = COALESCE((
        SELECT SUM(likes_received + replies_received + retweets_received)
        FROM interactions WHERE account_handle = ?
      ), 0),
      avg_reply_score = COALESCE((
        SELECT AVG(success_score) FROM interactions WHERE account_handle = ?
      ), 0),
      successful_replies = COALESCE((
        SELECT COUNT(*) FROM interactions
        WHERE account_handle = ? AND success_score >= ${SUCCESSFUL_REPLY_MIN_SCORE}
      ), 0),
      author_engaged_replies = COALESCE((
        SELECT COUNT(*) FROM interactions
        WHERE account_handle = ? AND author_engaged = 1
      ), 0),
      updated_at = unixepoch()
    WHERE handle = ?
  `).run(accountHandle, accountHandle, accountHandle, accountHandle, accountHandle);
}

export function listRecentInteractions(limit = 50): Interaction[] {
  return getDb()
    .prepare(`SELECT * FROM interactions ORDER BY posted_at DESC LIMIT ?`)
    .all(Math.min(Math.max(limit, 1), 500)) as Interaction[];
}

export function listRecentReplyTexts(limit = 25): string[] {
  return getDb()
    .prepare(`
      SELECT our_reply_text FROM interactions
      WHERE TRIM(our_reply_text) <> ''
      ORDER BY posted_at DESC
      LIMIT ?
    `)
    .all(Math.min(Math.max(limit, 1), 100))
    .map((row) => (row as { our_reply_text: string }).our_reply_text);
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
