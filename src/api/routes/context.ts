import express from 'express';
import { getDb } from '../../storage/db.js';
import { getSourceHealth } from '../../context/ingest/health.js';
import { isContextEnabled, getContextStore } from '../../context/enrich.js';
import { getTopicVelocities } from '../../context/trends.js';

export const contextRouter = express.Router();

interface ContextStats {
  total_items: number;
  total_vectors: number;
  newest_item_at: number | null;
  oldest_item_at: number | null;
  by_source: Array<{ source: string; count: number; newest_at: number | null }>;
}

function gatherStats(): ContextStats {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) AS c FROM context_items').get() as { c: number }).c;
  let totalVecs = 0;
  try {
    totalVecs = (db.prepare('SELECT COUNT(*) AS c FROM vec_context').get() as { c: number }).c;
  } catch {
    totalVecs = 0;
  }
  const range = db.prepare(`
    SELECT MIN(COALESCE(published_at, fetched_at)) AS oldest,
           MAX(COALESCE(published_at, fetched_at)) AS newest
    FROM context_items
  `).get() as { oldest: number | null; newest: number | null };

  const bySource = db.prepare(`
    SELECT source, COUNT(*) AS count,
           MAX(COALESCE(published_at, fetched_at)) AS newest_at
    FROM context_items
    GROUP BY source
    ORDER BY source
  `).all() as Array<{ source: string; count: number; newest_at: number | null }>;

  return {
    total_items: total,
    total_vectors: totalVecs,
    newest_item_at: range.newest,
    oldest_item_at: range.oldest,
    by_source: bySource,
  };
}

contextRouter.get('/health', (_req, res) => {
  const enabled = isContextEnabled();
  const apiKeyConfigured = Boolean(process.env.VOYAGE_API_KEY);
  const store = enabled ? getContextStore() : null;

  res.json({
    enabled,
    voyage_api_key_set: apiKeyConfigured,
    store_initialized: store !== null,
    sources: getSourceHealth(),
    stats: gatherStats(),
    trends: getTopicVelocities().slice(0, 10),
  });
});

contextRouter.get('/trends', (_req, res) => {
  res.json(getTopicVelocities());
});

contextRouter.get('/recent', (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
  const rows = getDb().prepare(`
    SELECT id, source, source_url, title, language, topics, published_at,
           fetched_at, credibility, length(body) AS body_len
    FROM context_items
    ORDER BY COALESCE(published_at, fetched_at) DESC
    LIMIT ?
  `).all(limit);
  res.json(rows);
});
