/**
 * Engagement performance by bait mode and top-performing outbound posts.
 *
 * Feeds real-time bait tuning: which subtype (click vs rage) earns more, and
 * which shipped texts to cite as few-shot examples in generation prompts.
 */
import { getDb } from './db.js';

export type TrackedEngagementMode = 'NONE' | 'CLICKBAIT' | 'RAGEBAIT' | 'RECEIPT';

export interface ModePerformanceRow {
  mode: TrackedEngagementMode;
  count: number;
  avg_score: number;
  avg_likes: number;
  avg_replies: number;
  avg_retweets: number;
  avg_impressions: number;
}

export interface TopPerformingReply {
  text: string;
  mode: TrackedEngagementMode;
  score: number;
  likes: number;
  replies: number;
  retweets: number;
  impressions: number;
  posted_at: number;
  kind: 'reply';
}

export interface TopPerformingOriginal {
  text: string;
  mode: TrackedEngagementMode;
  topic: string;
  score: number;
  likes: number;
  replies: number;
  retweets: number;
  impressions: number;
  posted_at: number;
  kind: 'original';
}

export type TopPerformingPost = TopPerformingReply | TopPerformingOriginal;

export interface BaitTuningSnapshot {
  /** Rolling window used for aggregates (days). */
  window_days: number;
  mode_performance: ModePerformanceRow[];
  /** Subtype pick probability for CLICKBAIT when both subtypes have enough data. */
  click_subtype_prob: number;
  top_bait_posts: TopPerformingPost[];
  top_overall_posts: TopPerformingPost[];
  computed_at: number;
}

const DEFAULT_WINDOW_DAYS = 14;
const MIN_SUBTYPE_SAMPLES = 3;

/** Same weighting as analytics + neural memory for apples-to-apples comparison. */
export function engagementScore(
  likes: number,
  replies: number,
  retweets: number,
  impressions = 0,
): number {
  return likes * 2 + replies * 5 + retweets * 3 + impressions * 0.01;
}

export function getModePerformance(windowDays = DEFAULT_WINDOW_DAYS): ModePerformanceRow[] {
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const db = getDb();

  const replyRows = db.prepare(`
    SELECT
      COALESCE(p.engagement_mode, 'NONE') AS mode,
      COUNT(*) AS count,
      ROUND(AVG(i.success_score), 2) AS avg_score,
      ROUND(AVG(i.likes_received), 2) AS avg_likes,
      ROUND(AVG(i.replies_received), 2) AS avg_replies,
      ROUND(AVG(i.retweets_received), 2) AS avg_retweets,
      ROUND(AVG(i.impressions), 2) AS avg_impressions
    FROM interactions i
    JOIN posts p ON p.id = i.post_id
    WHERE i.posted_at >= ?
    GROUP BY COALESCE(p.engagement_mode, 'NONE')
  `).all(since) as ModePerformanceRow[];

  const originalRows = db.prepare(`
  WITH latest_pi AS (
    SELECT pi.*
    FROM post_impressions pi
    JOIN (
      SELECT original_post_id, MAX(checked_at) AS checked_at
      FROM post_impressions
      GROUP BY original_post_id
    ) latest
      ON latest.original_post_id = pi.original_post_id
     AND latest.checked_at = pi.checked_at
  )
    SELECT
      COALESCE(op.engagement_mode, 'NONE') AS mode,
      COUNT(*) AS count,
      ROUND(AVG(
        lp.likes * 2 + lp.replies * 5 + lp.retweets * 3 + lp.impressions * 0.01
      ), 2) AS avg_score,
      ROUND(AVG(lp.likes), 2) AS avg_likes,
      ROUND(AVG(lp.replies), 2) AS avg_replies,
      ROUND(AVG(lp.retweets), 2) AS avg_retweets,
      ROUND(AVG(lp.impressions), 2) AS avg_impressions
    FROM original_posts op
    JOIN latest_pi lp ON lp.original_post_id = op.id
    WHERE op.status = 'POSTED' AND op.posted_at >= ?
    GROUP BY COALESCE(op.engagement_mode, 'NONE')
  `).all(since) as ModePerformanceRow[];

  return mergeModeRows(replyRows, originalRows);
}

export function getTopPerformingReplies(
  limit = 5,
  opts: { baitOnly?: boolean; windowDays?: number } = {},
): TopPerformingReply[] {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const baitFilter = opts.baitOnly
    ? `AND p.engagement_mode IN ('CLICKBAIT', 'RAGEBAIT', 'RECEIPT')`
    : '';

  const rows = getDb().prepare(`
    SELECT
      i.our_reply_text AS text,
      COALESCE(p.engagement_mode, 'NONE') AS mode,
      i.success_score AS score,
      i.likes_received AS likes,
      i.replies_received AS replies,
      i.retweets_received AS retweets,
      i.impressions,
      i.posted_at
    FROM interactions i
    JOIN posts p ON p.id = i.post_id
    WHERE i.posted_at >= ?
      AND TRIM(i.our_reply_text) <> ''
      ${baitFilter}
    ORDER BY i.success_score DESC, i.posted_at DESC
    LIMIT ?
  `).all(since, Math.min(Math.max(limit, 1), 20)) as Array<{
    text: string;
    mode: TrackedEngagementMode;
    score: number;
    likes: number;
    replies: number;
    retweets: number;
    impressions: number;
    posted_at: number;
  }>;

  return rows.map((row) => ({ ...row, kind: 'reply' as const }));
}

export function getTopPerformingOriginals(
  limit = 5,
  opts: { baitOnly?: boolean; windowDays?: number } = {},
): TopPerformingOriginal[] {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const baitFilter = opts.baitOnly
    ? `AND op.engagement_mode IN ('CLICKBAIT', 'RAGEBAIT', 'RECEIPT')`
    : '';

  const rows = getDb().prepare(`
  WITH latest_pi AS (
    SELECT pi.*
    FROM post_impressions pi
    JOIN (
      SELECT original_post_id, MAX(checked_at) AS checked_at
      FROM post_impressions
      GROUP BY original_post_id
    ) latest
      ON latest.original_post_id = pi.original_post_id
     AND latest.checked_at = pi.checked_at
  )
    SELECT
      op.content AS text,
      COALESCE(op.engagement_mode, 'NONE') AS mode,
      op.topic,
      (lp.likes * 2 + lp.replies * 5 + lp.retweets * 3 + lp.impressions * 0.01) AS score,
      lp.likes,
      lp.replies,
      lp.retweets,
      lp.impressions,
      op.posted_at
    FROM original_posts op
    JOIN latest_pi lp ON lp.original_post_id = op.id
    WHERE op.status = 'POSTED'
      AND op.posted_at >= ?
      AND TRIM(op.content) <> ''
      ${baitFilter}
    ORDER BY score DESC, op.posted_at DESC
    LIMIT ?
  `).all(since, Math.min(Math.max(limit, 1), 20)) as Array<{
    text: string;
    mode: TrackedEngagementMode;
    topic: string;
    score: number;
    likes: number;
    replies: number;
    retweets: number;
    impressions: number;
    posted_at: number;
  }>;

  return rows.map((row) => ({ ...row, kind: 'original' as const }));
}

/**
 * CLICKBAIT probability when picking a bait subtype. 0.5 until both modes have
 * enough samples; then weighted by avg score with a 30–70% clamp.
 */
export function computeClickSubtypeProb(rows: ModePerformanceRow[]): number {
  const click = rows.find((r) => r.mode === 'CLICKBAIT');
  const rage = rows.find((r) => r.mode === 'RAGEBAIT');
  if (!click || !rage) return 0.5;
  if (click.count < MIN_SUBTYPE_SAMPLES || rage.count < MIN_SUBTYPE_SAMPLES) return 0.5;

  const clickScore = Math.max(click.avg_score, 0.1);
  const rageScore = Math.max(rage.avg_score, 0.1);
  const raw = clickScore / (clickScore + rageScore);
  return Math.min(0.7, Math.max(0.3, raw));
}

export function getBaitTuningSnapshot(windowDays = DEFAULT_WINDOW_DAYS): BaitTuningSnapshot {
  const modePerformance = getModePerformance(windowDays);
  const topBaitReplies = getTopPerformingReplies(3, { baitOnly: true, windowDays });
  const topBaitOriginals = getTopPerformingOriginals(3, { baitOnly: true, windowDays });
  const topOverallReplies = getTopPerformingReplies(3, { windowDays });
  const topOverallOriginals = getTopPerformingOriginals(3, { windowDays });

  const topBaitPosts = mergeTopPosts(topBaitReplies, topBaitOriginals, 5);
  const topOverallPosts = mergeTopPosts(topOverallReplies, topOverallOriginals, 5);

  return {
    window_days: windowDays,
    mode_performance: modePerformance,
    click_subtype_prob: computeClickSubtypeProb(modePerformance),
    top_bait_posts: topBaitPosts,
    top_overall_posts: topOverallPosts,
    computed_at: Math.floor(Date.now() / 1000),
  };
}

function mergeModeRows(a: ModePerformanceRow[], b: ModePerformanceRow[]): ModePerformanceRow[] {
  const map = new Map<TrackedEngagementMode, ModePerformanceRow>();

  for (const row of [...a, ...b]) {
    const mode = normalizeMode(row.mode);
    const existing = map.get(mode);
    if (!existing) {
      map.set(mode, { ...row, mode });
      continue;
    }
    const total = existing.count + row.count;
    if (total === 0) continue;
    map.set(mode, {
      mode,
      count: total,
      avg_score: weightedAvg(existing.avg_score, existing.count, row.avg_score, row.count),
      avg_likes: weightedAvg(existing.avg_likes, existing.count, row.avg_likes, row.count),
      avg_replies: weightedAvg(existing.avg_replies, existing.count, row.avg_replies, row.count),
      avg_retweets: weightedAvg(existing.avg_retweets, existing.count, row.avg_retweets, row.count),
      avg_impressions: weightedAvg(existing.avg_impressions, existing.count, row.avg_impressions, row.count),
    });
  }

  return [...map.values()].sort((x, y) => y.avg_score - x.avg_score);
}

function weightedAvg(a: number, aN: number, b: number, bN: number): number {
  const total = aN + bN;
  if (total === 0) return 0;
  return Math.round(((a * aN + b * bN) / total) * 100) / 100;
}

function normalizeMode(mode: string): TrackedEngagementMode {
  if (mode === 'CLICKBAIT' || mode === 'RAGEBAIT' || mode === 'RECEIPT') return mode;
  return 'NONE';
}

/** Blend raw engagement score with reply-rate so few-shot examples earn arguments, not just views. */
export function baitExampleRankScore(post: TopPerformingPost): number {
  const replyRate = post.impressions > 0 ? post.replies / post.impressions : 0;
  return post.score + replyRate * 500;
}

function mergeTopPosts(
  replies: TopPerformingReply[],
  originals: TopPerformingOriginal[],
  limit: number,
): TopPerformingPost[] {
  return [...replies, ...originals]
    .sort((a, b) => baitExampleRankScore(b) - baitExampleRankScore(a) || b.posted_at - a.posted_at)
    .slice(0, limit);
}

const DEVANAGARI_RE = /[ऀ-ॿ]/;

export function getTopConversationalReplies(
  limit = 5,
  windowDays = DEFAULT_WINDOW_DAYS,
): TopPerformingReply[] {
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const rows = getDb().prepare(`
    SELECT
      i.our_reply_text AS text,
      COALESCE(p.engagement_mode, 'NONE') AS mode,
      i.success_score AS score,
      i.likes_received AS likes,
      i.replies_received AS replies,
      i.retweets_received AS retweets,
      i.impressions,
      i.posted_at
    FROM interactions i
    JOIN posts p ON p.id = i.post_id
    WHERE i.posted_at >= ?
      AND TRIM(i.our_reply_text) <> ''
      AND (
        i.replies_received > 0
        OR i.author_engaged = 1
        OR i.success_score > 0
      )
    ORDER BY i.replies_received DESC, i.author_engaged DESC, i.success_score DESC, i.posted_at DESC
    LIMIT ?
  `).all(since, Math.min(Math.max(limit, 1), 20)) as Array<{
    text: string;
    mode: TrackedEngagementMode;
    score: number;
    likes: number;
    replies: number;
    retweets: number;
    impressions: number;
    posted_at: number;
  }>;

  return rows
    .filter((row) => !DEVANAGARI_RE.test(row.text))
    .map((row) => ({ ...row, kind: 'reply' as const }));
}

/** Few-shot winners for every generation path — replies that earned replies. */
export function winnerExamplesBlock(limit = 3): string {
  try {
    const picks = getTopConversationalReplies(limit);
    if (picks.length === 0) return '';
    const lines = picks.map((p, i) => {
      const snippet = p.text.replace(/\s+/g, ' ').trim().slice(0, 220);
      return `${i + 1}. [replies ${p.replies} · score ${p.score.toFixed(1)}] ${snippet}`;
    });
    return [
      'RECENT REPLIES THAT EARNED REPLIES (match energy and structure, not exact words):',
      ...lines,
    ].join('\n');
  } catch {
    return '';
  }
}
