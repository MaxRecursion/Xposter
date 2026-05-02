import { getDb } from '../storage/db.js';

export interface TopicVelocity {
  topic: string;
  last6h: number;
  last24h: number;
  velocity: number;          // (last6h+1) / (last24h/4 + 1) — > 1 = trending
}

/**
 * Compute trend velocity per topic from context_items.topics.
 *
 * Each item carries a JSON array of topic strings. We approximate "is this
 * topic getting more reporting recently than usual?" with a 6h vs prior-24h
 * comparison. A velocity > 1 means the last 6h share is higher than its
 * proportional share of the last 24h.
 */
export function getTopicVelocities(): TopicVelocity[] {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const cutoff6h = now - 6 * 3600;
  const cutoff24h = now - 24 * 3600;

  // Pull topic JSON arrays from items in the last 24h, then aggregate in JS.
  const rows = db.prepare(`
    SELECT topics, COALESCE(published_at, fetched_at) AS ts
    FROM context_items
    WHERE COALESCE(published_at, fetched_at) >= ?
  `).all(cutoff24h) as Array<{ topics: string; ts: number }>;

  const last6h = new Map<string, number>();
  const last24h = new Map<string, number>();

  for (const row of rows) {
    let arr: string[] = [];
    try {
      arr = JSON.parse(row.topics) as string[];
    } catch {
      continue;
    }
    for (const t of arr) {
      last24h.set(t, (last24h.get(t) ?? 0) + 1);
      if (row.ts >= cutoff6h) last6h.set(t, (last6h.get(t) ?? 0) + 1);
    }
  }

  const topics = new Set([...last24h.keys(), ...last6h.keys()]);
  const out: TopicVelocity[] = [];
  for (const topic of topics) {
    const a = last6h.get(topic) ?? 0;
    const b = last24h.get(topic) ?? 0;
    const velocity = (a + 1) / (b / 4 + 1);
    out.push({ topic, last6h: a, last24h: b, velocity });
  }
  out.sort((x, y) => y.velocity - x.velocity);
  return out;
}

/** Map of topic → velocity for quick lookup in pickTopic. */
export function getVelocityMap(): Map<string, number> {
  return new Map(getTopicVelocities().map((v) => [v.topic, v.velocity]));
}
