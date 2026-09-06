import { getDb } from './db.js';
import { detectTopics } from '../context/topics.js';
import { JUDGE_PASS_THRESHOLD } from '../eval/judge.js';

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

export interface SourcePerformance {
  /** TIMELINE | TREND_GLOBAL | TREND_INDIA */
  source: string;
  total_replies: number;
  successful_replies: number;
  success_rate: number;
  avg_success_score: number;
  avg_likes: number;
  avg_impressions: number;
}

export interface QualityRateRow {
  key: string;
  sample_size: number;
  actions_per_1k_impressions: number | null;
  avg_success_score: number;
}

export interface TournamentQualitySummary {
  sample_size: number;
  tournament_sample_size: number;
  control_sample_size: number;
  tournament_actions_per_1k: number | null;
  control_actions_per_1k: number | null;
  best_angle: { angle: string; sample_size: number; actions_per_1k_impressions: number | null } | null;
  by_strategy: QualityRateRow[];
  by_angle: QualityRateRow[];
}

export interface AnalyticsOverview {
  days: number;
  summary: {
    follower_delta: number;
    replies: number;
    originals: number;
    successful_replies: number;
    actions_per_1k_impressions: number | null;
    quality_sample_size: number;
    avg_judge_score: number | null;
    judge_pass_rate: number | null;
    judge_sample_size: number;
  };
  follower_growth: FollowerGrowthPoint[];
  reply_by_classification: ReplyClassPerformance[];
  reply_by_source: SourcePerformance[];
  topic_trends: TopicTrendPoint[];
  posting_hours: PostingHourPerformance[];
  quality: {
    by_source: QualityRateRow[];
    by_hour: QualityRateRow[];
    by_topic: QualityRateRow[];
    by_stance: QualityRateRow[];
    by_content_structure: QualityRateRow[];
  };
  tournament: TournamentQualitySummary;
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

  // How well our replies perform depending on where we sourced the candidate tweet
  // (timeline scroll vs trending hashtag). Joins via posts.source which is written
  // at ingestion time. Only rows with a metric sync are included (posted replies
  // that haven't been checked yet have success_score = 0 and would skew the avg).
  const replyBySource = db.prepare(`
    SELECT
      COALESCE(p.source, 'TIMELINE') AS source,
      COUNT(*) AS total_replies,
      SUM(CASE WHEN i.success_score >= 5 THEN 1 ELSE 0 END) AS successful_replies,
      ROUND(
        100.0 * SUM(CASE WHEN i.success_score >= 5 THEN 1 ELSE 0 END) / COUNT(*),
        1
      ) AS success_rate,
      ROUND(AVG(i.success_score), 1) AS avg_success_score,
      ROUND(AVG(i.likes_received), 1) AS avg_likes,
      ROUND(AVG(i.impressions), 1) AS avg_impressions
    FROM interactions i
    JOIN posts p ON p.id = i.post_id
    WHERE i.posted_at >= ?
      AND i.last_metric_check IS NOT NULL
    GROUP BY COALESCE(p.source, 'TIMELINE')
    ORDER BY avg_success_score DESC
  `).all(since) as SourcePerformance[];

  const originals = (db.prepare(`
    SELECT COUNT(*) AS count FROM original_posts
    WHERE status = 'POSTED' AND posted_at >= ?
  `).get(since) as { count: number }).count;
  const replies = replyByClassification.reduce((sum, row) => sum + row.total_replies, 0);
  const successfulReplies = replyByClassification
    .reduce((sum, row) => sum + row.successful_replies, 0);

  const quality = loadReplyQuality(db, since);
  const tournament = loadTournamentQuality(db, since);
  const judge = loadJudgeQuality(db, since);

  return {
    days: windowDays,
    summary: {
      follower_delta: followerGrowth.reduce((sum, row) => sum + row.net, 0),
      replies,
      originals,
      successful_replies: successfulReplies,
      actions_per_1k_impressions: quality.overall.actions_per_1k_impressions,
      quality_sample_size: quality.overall.sample_size,
      avg_judge_score: judge.avg_judge_score,
      judge_pass_rate: judge.judge_pass_rate,
      judge_sample_size: judge.judge_sample_size,
    },
    follower_growth: followerGrowth,
    reply_by_classification: replyByClassification,
    reply_by_source: replyBySource,
    topic_trends: topicTrends,
    posting_hours: postingHours,
    quality: {
      by_source: quality.by_source,
      by_hour: quality.by_hour,
      by_topic: quality.by_topic,
      by_stance: quality.by_stance,
      by_content_structure: quality.by_content_structure,
    },
    tournament,
  };
}

interface SyncedReplyRow {
  likes: number;
  replies: number;
  retweets: number;
  impressions: number;
  success_score: number;
  source: string;
  hour: number | null;
  stance: string | null;
  content_structure: string | null;
  tournament_strategy: string | null;
  tournament_angle: string | null;
  text: string;
}

const SYNCED_REPLY_SQL = `
  SELECT
    i.likes_received AS likes,
    i.replies_received AS replies,
    i.retweets_received AS retweets,
    i.impressions,
    i.success_score,
    COALESCE(p.source, 'TIMELINE') AS source,
    CAST(strftime('%H', i.posted_at, 'unixepoch', 'localtime') AS INTEGER) AS hour,
    p.stance,
    i.content_structure,
    p.tournament_strategy,
    p.tournament_angle,
    p.text
  FROM interactions i
  JOIN posts p ON p.id = i.post_id
  WHERE i.posted_at >= ?
    AND i.last_metric_check IS NOT NULL
    AND i.impressions > 0
`;

function loadSyncedReplies(db: ReturnType<typeof getDb>, since: number): SyncedReplyRow[] {
  return db.prepare(SYNCED_REPLY_SQL).all(since) as SyncedReplyRow[];
}

export function actionsPer1k(
  rows: Array<{ likes: number; replies: number; retweets: number; impressions: number }>,
): { sample_size: number; actions_per_1k_impressions: number | null; avg_success_score: number } {
  const sample_size = rows.length;
  if (sample_size === 0) {
    return { sample_size: 0, actions_per_1k_impressions: null, avg_success_score: 0 };
  }
  const impressions = rows.reduce((sum, r) => sum + r.impressions, 0);
  const actions = rows.reduce((sum, r) => sum + r.likes + r.replies + r.retweets, 0);
  const avgScore = rows.reduce((sum, r) => sum + ((r as { success_score?: number }).success_score ?? 0), 0) / sample_size;
  return {
    sample_size,
    actions_per_1k_impressions: impressions > 0
      ? Math.round((actions * 1000 / impressions) * 100) / 100
      : null,
    avg_success_score: Math.round(avgScore * 10) / 10,
  };
}

function groupQuality(
  rows: SyncedReplyRow[],
  keyFn: (row: SyncedReplyRow) => string,
): QualityRateRow[] {
  const groups = new Map<string, SyncedReplyRow[]>();
  for (const row of rows) {
    const key = keyFn(row) || 'unknown';
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const stats = actionsPer1k(list);
      return {
        key,
        sample_size: stats.sample_size,
        actions_per_1k_impressions: stats.actions_per_1k_impressions,
        avg_success_score: stats.avg_success_score,
      };
    })
    .sort((a, b) => (b.actions_per_1k_impressions ?? -1) - (a.actions_per_1k_impressions ?? -1));
}

function loadReplyQuality(db: ReturnType<typeof getDb>, since: number) {
  const rows = loadSyncedReplies(db, since);
  const topicRows: QualityRateRow[] = [];
  const topicBuckets = new Map<string, SyncedReplyRow[]>();
  for (const row of rows) {
    const topics = detectTopics(row.text);
    const keys = topics.length > 0 ? topics : ['untagged'];
    for (const topic of keys) {
      const list = topicBuckets.get(topic) ?? [];
      list.push(row);
      topicBuckets.set(topic, list);
    }
  }
  for (const [key, list] of topicBuckets) {
    const stats = actionsPer1k(list);
    topicRows.push({
      key,
      sample_size: stats.sample_size,
      actions_per_1k_impressions: stats.actions_per_1k_impressions,
      avg_success_score: stats.avg_success_score,
    });
  }
  topicRows.sort((a, b) => (b.actions_per_1k_impressions ?? -1) - (a.actions_per_1k_impressions ?? -1));

  return {
    overall: actionsPer1k(rows),
    by_source: groupQuality(rows, (r) => r.source),
    by_hour: groupQuality(rows, (r) => String(r.hour ?? 'unknown')),
    by_topic: topicRows.slice(0, 20),
    by_stance: groupQuality(rows, (r) => r.stance ?? 'none'),
    by_content_structure: groupQuality(rows, (r) => r.content_structure ?? 'standard'),
  };
}

function loadJudgeQuality(
  db: ReturnType<typeof getDb>,
  since: number,
): { avg_judge_score: number | null; judge_pass_rate: number | null; judge_sample_size: number } {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS sample_size,
      AVG(judge_score) AS avg_score,
      SUM(CASE WHEN judge_score >= ${JUDGE_PASS_THRESHOLD} THEN 1 ELSE 0 END) AS passed
    FROM interactions
    WHERE judge_evaluated_at IS NOT NULL AND posted_at >= ?
  `).get(since) as { sample_size: number; avg_score: number | null; passed: number };

  if (row.sample_size === 0) {
    return { avg_judge_score: null, judge_pass_rate: null, judge_sample_size: 0 };
  }
  return {
    avg_judge_score: Math.round((row.avg_score ?? 0) * 10) / 10,
    judge_pass_rate: Math.round((row.passed / row.sample_size) * 1000) / 10,
    judge_sample_size: row.sample_size,
  };
}

function loadTournamentQuality(db: ReturnType<typeof getDb>, since: number): TournamentQualitySummary {
  const rows = loadSyncedReplies(db, since);
  const tournamentRows = rows.filter((r) => r.tournament_strategy === 'TOURNAMENT');
  const controlRows = rows.filter((r) => r.tournament_strategy === 'CONTROL' || !r.tournament_strategy);
  const by_strategy = groupQuality(rows, (r) => r.tournament_strategy ?? 'CONTROL');
  const by_angle = groupQuality(
    tournamentRows.filter((r) => r.tournament_angle),
    (r) => r.tournament_angle ?? 'unknown',
  );
  const best = by_angle[0] ?? null;
  return {
    sample_size: rows.length,
    tournament_sample_size: tournamentRows.length,
    control_sample_size: controlRows.length,
    tournament_actions_per_1k: actionsPer1k(tournamentRows).actions_per_1k_impressions,
    control_actions_per_1k: actionsPer1k(controlRows).actions_per_1k_impressions,
    best_angle: best
      ? {
        angle: best.key,
        sample_size: best.sample_size,
        actions_per_1k_impressions: best.actions_per_1k_impressions,
      }
      : null,
    by_strategy,
    by_angle,
  };
}

function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
