import { getDb } from './db.js';

export interface FollowerGrowthPoint {
  day: string;
  gained: number;
  lost: number;
  net: number;
  cumulative: number;
}

export interface ReplyClassPerformance {
  classification: string;
  total_replies: number;
  successful_replies: number;
  success_rate: number;
  avg_success_score: number;
  avg_likes: number;
  avg_replies: number;
  avg_retweets: number;
}

export interface TopicTrendPoint {
  topic: string;
  checked_at: number;
  impressions: number;
  likes: number;
  replies: number;
  retweets: number;
  engagement_score: number;
}

export interface PostingHourPerformance {
  hour: number;
  posts: number;
  avg_engagement_score: number;
}

export interface AnalyticsOverview {
  days: number;
  summary: {
    follower_delta: number;
    replies: number;
    originals: number;
    successful_replies: number;
  };
  follower_growth: FollowerGrowthPoint[];
  reply_by_classification: ReplyClassPerformance[];
  topic_trends: TopicTrendPoint[];
  posting_hours: PostingHourPerformance[];
}

export function getAnalyticsOverview(days = 30): AnalyticsOverview {
  const windowDays = Math.min(Math.max(Math.trunc(days), 7), 90);
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const db = getDb();

  const followerRows = db.prepare(`
    SELECT
      date(detected_at, 'unixepoch', 'localtime') AS day,
      SUM(CASE WHEN event_type = 'NEW_FOLLOWER' THEN 1 ELSE 0 END) AS gained,
      SUM(CASE WHEN event_type = 'UNFOLLOWED' THEN 1 ELSE 0 END) AS lost
    FROM follower_events
    WHERE detected_at >= ?
      AND event_type IN ('NEW_FOLLOWER', 'UNFOLLOWED')
    GROUP BY day
    ORDER BY day
  `).all(since) as Array<{ day: string; gained: number; lost: number }>;

  const followerByDay = new Map(followerRows.map((row) => [row.day, row]));
  let cumulative = 0;
  const followerGrowth: FollowerGrowthPoint[] = [];
  for (let offset = windowDays - 1; offset >= 0; offset--) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const day = localDateKey(date);
    const row = followerByDay.get(day);
    const gained = row?.gained ?? 0;
    const lost = row?.lost ?? 0;
    const net = gained - lost;
    cumulative += net;
    followerGrowth.push({ day, gained, lost, net, cumulative });
  }

  const replyByClassification = db.prepare(`
    SELECT
      COALESCE(a.classification, 'UNKNOWN') AS classification,
      COUNT(*) AS total_replies,
      SUM(CASE WHEN i.success_score >= 5 THEN 1 ELSE 0 END) AS successful_replies,
      ROUND(
        100.0 * SUM(CASE WHEN i.success_score >= 5 THEN 1 ELSE 0 END) / COUNT(*),
        1
      ) AS success_rate,
      ROUND(AVG(i.success_score), 1) AS avg_success_score,
      ROUND(AVG(i.likes_received), 1) AS avg_likes,
      ROUND(AVG(i.replies_received), 1) AS avg_replies,
      ROUND(AVG(i.retweets_received), 1) AS avg_retweets
    FROM interactions i
    LEFT JOIN accounts a ON a.handle = i.account_handle
    WHERE i.posted_at >= ?
    GROUP BY COALESCE(a.classification, 'UNKNOWN')
    ORDER BY avg_success_score DESC, total_replies DESC
  `).all(since) as ReplyClassPerformance[];

  const topicTrends = db.prepare(`
    SELECT
      op.topic,
      pi.checked_at,
      pi.impressions,
      pi.likes,
      pi.replies,
      pi.retweets,
      ROUND(
        pi.likes * 2 + pi.replies * 5 + pi.retweets * 3 + pi.impressions * 0.01,
        2
      ) AS engagement_score
    FROM post_impressions pi
    JOIN original_posts op ON op.id = pi.original_post_id
    WHERE pi.checked_at >= ?
    ORDER BY pi.checked_at, op.topic
    LIMIT 1000
  `).all(since) as TopicTrendPoint[];

  const postingHours = db.prepare(`
    WITH latest_original AS (
      SELECT pi.*
      FROM post_impressions pi
      JOIN (
        SELECT original_post_id, MAX(checked_at) AS checked_at
        FROM post_impressions
        GROUP BY original_post_id
      ) latest
        ON latest.original_post_id = pi.original_post_id
       AND latest.checked_at = pi.checked_at
    ),
    scored AS (
      SELECT
        CAST(strftime('%H', op.posted_at, 'unixepoch', 'localtime') AS INTEGER) AS hour,
        (lo.likes * 2 + lo.replies * 5 + lo.retweets * 3 + lo.impressions * 0.01) AS score
      FROM original_posts op
      LEFT JOIN latest_original lo ON lo.original_post_id = op.id
      WHERE op.status = 'POSTED' AND op.posted_at >= ?

      UNION ALL

      SELECT
        CAST(strftime('%H', i.posted_at, 'unixepoch', 'localtime') AS INTEGER) AS hour,
        i.success_score AS score
      FROM interactions i
      WHERE i.posted_at >= ?
    )
    SELECT
      hour,
      COUNT(*) AS posts,
      ROUND(AVG(COALESCE(score, 0)), 1) AS avg_engagement_score
    FROM scored
    WHERE hour IS NOT NULL
    GROUP BY hour
    ORDER BY hour
  `).all(since, since) as PostingHourPerformance[];

  const originals = (db.prepare(`
    SELECT COUNT(*) AS count FROM original_posts
    WHERE status = 'POSTED' AND posted_at >= ?
  `).get(since) as { count: number }).count;
  const replies = replyByClassification.reduce((sum, row) => sum + row.total_replies, 0);
  const successfulReplies = replyByClassification
    .reduce((sum, row) => sum + row.successful_replies, 0);

  return {
    days: windowDays,
    summary: {
      follower_delta: followerGrowth.reduce((sum, row) => sum + row.net, 0),
      replies,
      originals,
      successful_replies: successfulReplies,
    },
    follower_growth: followerGrowth,
    reply_by_classification: replyByClassification,
    topic_trends: topicTrends,
    posting_hours: postingHours,
  };
}

function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
