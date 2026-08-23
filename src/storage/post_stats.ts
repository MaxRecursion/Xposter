import { getDb } from './db.js';
import { startOfLocalDayUnix } from '../utils/time.js';
import { detectTopics } from '../context/topics.js';

/**
 * Returns the set of author_handles that have already had a reply POSTED today
 * (midnight-to-now in local Unix time). Used to enforce the one-reply-per-account
 * per-day rule regardless of which post triggered the reply.
 */
export function getHandlesRepliedToToday(): Set<string> {
  const startOfDay = startOfLocalDayUnix();
  const rows = getDb()
    .prepare(`
      SELECT DISTINCT author_handle
      FROM posts
      WHERE status = 'POSTED'
        AND updated_at >= ?
    `)
    .all(startOfDay) as Array<{ author_handle: string }>;
  return new Set(rows.map((r) => r.author_handle));
}

/**
 * Total count of replies POSTED today (midnight-to-now, local time).
 * Used to enforce the `max_replies_per_day` hard cap.
 */
export function getRepliesPostedTodayCount(): number {
  const startOfDay = startOfLocalDayUnix();
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM posts WHERE status = 'POSTED' AND updated_at >= ?`)
    .get(startOfDay) as { n: number };
  return row.n;
}

/**
 * Counts today's POSTED replies by stance (midnight-to-now, local time).
 */
export function getStanceCountsToday(): { aligned: number; contrarian: number } {
  const startOfDay = startOfLocalDayUnix();
  const rows = getDb().prepare(`
    SELECT stance, COUNT(*) AS n
    FROM posts
    WHERE status = 'POSTED' AND updated_at >= ? AND stance IS NOT NULL
    GROUP BY stance
  `).all(startOfDay) as Array<{ stance: string; n: number }>;

  const out = { aligned: 0, contrarian: 0 };
  for (const row of rows) {
    if (row.stance === 'CONTRARIAN') out.contrarian = row.n;
    else if (row.stance === 'ALIGNED') out.aligned = row.n;
  }
  return out;
}

/**
 * Counts today's POSTED replies by engagement bait mode.
 * Modes CLICKBAIT/RAGEBAIT/RECEIPT count as bait; everything else (incl. null) as normal.
 */
export function getReplyBaitCountsToday(): { bait: number; normal: number } {
  const startOfDay = startOfLocalDayUnix();
  const rows = getDb().prepare(`
    SELECT engagement_mode AS mode, COUNT(*) AS n
    FROM posts
    WHERE status = 'POSTED' AND updated_at >= ?
    GROUP BY engagement_mode
  `).all(startOfDay) as Array<{ mode: string | null; n: number }>;

  let bait = 0;
  let normal = 0;
  for (const row of rows) {
    if (row.mode === 'CLICKBAIT' || row.mode === 'RAGEBAIT' || row.mode === 'RECEIPT') bait += row.n;
    else normal += row.n;
  }
  return { bait, normal };
}

/**
 * Returns a map of topic → count of how many times that topic has been
 * replied-to or posted-about today (midnight-to-now).
 */
export function getTopicCountsToday(): Map<string, number> {
  const startOfDay = startOfLocalDayUnix();
  const db = getDb();
  const counts = new Map<string, number>();

  const inc = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

  const replies = db.prepare(
    `SELECT text FROM posts WHERE status = 'POSTED' AND updated_at >= ?`,
  ).all(startOfDay) as Array<{ text: string }>;
  for (const { text } of replies) {
    for (const t of detectTopics(text)) inc(t);
  }

  try {
    const originals = db.prepare(
      `SELECT topic FROM original_posts WHERE status = 'POSTED' AND created_at >= ?`,
    ).all(startOfDay) as Array<{ topic: string }>;
    for (const { topic } of originals) {
      inc(topic.toLowerCase());
      for (const t of detectTopics(topic)) inc(t);
    }
  } catch {
    // original_posts table may not exist on very old DBs
  }

  return counts;
}
