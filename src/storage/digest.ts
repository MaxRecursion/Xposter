import { getDb } from './db.js';

export interface WeeklyDigest {
  since: number;
  until: number;
  replies_posted: number;
  originals_posted: number;
  approval_rate: number | null;
  approvals: number;
  skips: number;
  follower_delta: number;
  followers_gained: number;
  followers_lost: number;
  top_reply: {
    text: string;
    author_handle: string;
    tweet_url: string | null;
    success_score: number;
    likes: number;
    replies: number;
    retweets: number;
  } | null;
  best_topic: {
    topic: string;
    posts: number;
    avg_engagement_score: number;
  } | null;
}

export function getWeeklyDigest(until = Math.floor(Date.now() / 1000)): WeeklyDigest {
  const since = until - 7 * 86400;
  const db = getDb();

  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM interactions WHERE posted_at >= ? AND posted_at < ?) AS replies,
      (SELECT COUNT(*) FROM original_posts
       WHERE status = 'POSTED' AND posted_at >= ? AND posted_at < ?) AS originals
  `).get(since, until, since, until) as { replies: number; originals: number };

  const decisions = db.prepare(`
    SELECT
      SUM(CASE WHEN event = 'APPROVE' THEN 1 ELSE 0 END) AS approvals,
      SUM(CASE WHEN event = 'SKIP' THEN 1 ELSE 0 END) AS skips
    FROM activity_log
    WHERE created_at >= ? AND created_at < ?
      AND event IN ('APPROVE', 'SKIP')
  `).get(since, until) as { approvals: number | null; skips: number | null };
  const approvals = decisions.approvals ?? 0;
  const skips = decisions.skips ?? 0;
  const approvalRate = approvals + skips > 0
    ? Math.round((approvals / (approvals + skips)) * 1000) / 10
    : null;

  const followers = db.prepare(`
    SELECT
      SUM(CASE WHEN event_type = 'NEW_FOLLOWER' THEN 1 ELSE 0 END) AS gained,
      SUM(CASE WHEN event_type = 'UNFOLLOWED' THEN 1 ELSE 0 END) AS lost
    FROM follower_events
    WHERE detected_at >= ? AND detected_at < ?
  `).get(since, until) as { gained: number | null; lost: number | null };
  const gained = followers.gained ?? 0;
  const lost = followers.lost ?? 0;

  const topReply = (db.prepare(`
    SELECT
      i.our_reply_text AS text,
      i.account_handle AS author_handle,
      i.our_tweet_url AS tweet_url,
      i.success_score,
      i.likes_received AS likes,
      i.replies_received AS replies,
      i.retweets_received AS retweets
    FROM interactions i
    WHERE i.posted_at >= ? AND i.posted_at < ?
    ORDER BY i.success_score DESC, i.posted_at DESC
    LIMIT 1
  `).get(since, until) as WeeklyDigest['top_reply'] | undefined) ?? null;

  const bestTopic = (db.prepare(`
    SELECT
      op.topic,
      COUNT(DISTINCT op.id) AS posts,
      ROUND(AVG(
        pi.likes * 2 + pi.replies * 5 + pi.retweets * 3 + pi.impressions * 0.01
      ), 1) AS avg_engagement_score
    FROM original_posts op
    JOIN post_impressions pi ON pi.original_post_id = op.id
    WHERE op.posted_at >= ? AND op.posted_at < ?
    GROUP BY op.topic
    ORDER BY avg_engagement_score DESC
    LIMIT 1
  `).get(since, until) as WeeklyDigest['best_topic'] | undefined) ?? null;

  return {
    since,
    until,
    replies_posted: counts.replies,
    originals_posted: counts.originals,
    approval_rate: approvalRate,
    approvals,
    skips,
    follower_delta: gained - lost,
    followers_gained: gained,
    followers_lost: lost,
    top_reply: topReply,
    best_topic: bestTopic,
  };
}
