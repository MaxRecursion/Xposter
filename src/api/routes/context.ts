import express from 'express';
import { getDb } from '../../storage/db.js';
import { getSourceHealth } from '../../context/ingest/health.js';
import { isContextEnabled, getContextStore, enrichPrompt } from '../../context/enrich.js';
import { getTopicVelocities } from '../../context/trends.js';
import { detectTopics } from '../../context/topics.js';
import { generateReply } from '../../pipeline/generator.js';
import { detectLanguage } from '../../pipeline/filter.js';
import { buildNeuralSchemaMemory, loadMemoryEvents } from '../../context/neural_memory.js';
import type { Post } from '../../storage/queries.js';
import { logger } from '../../utils/logger.js';
import { getVoyageApiKey } from '../../config.js';
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
  const apiKeyConfigured = Boolean(getVoyageApiKey());
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

/**
 * Run the full reply-generation path against a synthetic tweet. Exercises
 * context retrieval, prompt assembly, and the Groq call — useful for
 * debugging without touching the timeline or DB writes. Does NOT post the
 * reply anywhere.
 */
contextRouter.post('/test-reply', async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'missing text in JSON body' });
  if (text.length > 1000) return res.status(400).json({ error: 'text too long' });

  const handle = String(req.body?.handle ?? 'debug_user');
  const language = req.body?.language && typeof req.body.language === 'string'
    ? req.body.language
    : (detectLanguage(text) ?? 'english');

  const synthPost: Post = {
    id: 'debug-' + Date.now().toString(36),
    tweet_id: '0',
    author_handle: handle,
    author_name: handle,
    text,
    language,
    timestamp: Math.floor(Date.now() / 1000),
    likes: 0,
    replies: 0,
    retweets: 0,
    tweet_url: `https://x.com/${handle}/status/0`,
    status: 'GENERATING',
    score: null,
    score_breakdown: null,
    generated_reply: null,
    final_reply: null,
    posted_tweet_id: null,
    source: 'TIMELINE',
    stance: null,
    trend_key: null,
    engagement_mode: null,
    deleted_at: null,
    posting_attempts: 0,
    retry_after: null,
    last_error: null,
    ingested_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  };

  const start = Date.now();
  try {
    const reply = await generateReply(synthPost, null);
    res.json({
      ok: true,
      input: { text, handle, language },
      reply,
      elapsed_ms: Date.now() - start,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('test-reply failed', { err: msg });
    res.status(500).json({ ok: false, error: msg });
  }
});

/**
 * Preview the enrichment block that would be injected into a prompt for the
 * given query. Read-only; useful for tuning the retriever and inspecting what
 * the model actually sees. Costs one Voyage embedding call per request.
 */
contextRouter.get('/preview', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    return res.status(400).json({ error: 'missing q parameter' });
  }
  const maxItems = Math.min(10, Math.max(1, parseInt(String(req.query.k ?? '5'), 10) || 5));
  const maxTokens = Math.min(2000, Math.max(50, parseInt(String(req.query.tokens ?? '500'), 10) || 500));

  if (!isContextEnabled()) {
    return res.json({ enabled: false, query: q, block: '' });
  }

  const start = Date.now();
  const block = await enrichPrompt({ text: q, maxItems, maxTokens });
  const detectedTopics = detectTopics(q);

  res.json({
    enabled: true,
    query: q,
    detected_topics: detectedTopics,
    block_chars: block.length,
    elapsed_ms: Date.now() - start,
    block,
  });
});

/**
 * Return the full neural schema memory graph (nodes + edges + recent events)
 * for dashboard visualization. Limits nodes/edges for UI performance.
 */
contextRouter.get('/neural-memory', (_req, res) => {
  try {
    const events = loadMemoryEvents(300);
    const memory = buildNeuralSchemaMemory(events);

    const MAX_NODES = 35;
    const MAX_EDGES = 60;

    const topNodes = memory.nodes.slice(0, MAX_NODES);
    const nodeKeys = new Set(topNodes.map((n) => n.key));
    const topEdges = memory.edges
      .filter((e) => nodeKeys.has(e.from) && nodeKeys.has(e.to))
      .slice(0, MAX_EDGES);

    const recentEvents = memory.events
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 15)
      .map((e) => ({
        kind: e.kind,
        text: e.text.slice(0, 120),
        topic: e.topic,
        concepts: e.concepts.slice(0, 6),
        createdAt: e.createdAt,
        engagement: e.engagement,
        score: e.score,
      }));

    res.json({
      nodes: topNodes,
      edges: topEdges,
      recentEvents,
      stats: {
        totalNodes: memory.nodes.length,
        totalEdges: memory.edges.length,
        totalEvents: memory.events.length,
        originals: events.filter((e) => e.kind === 'original').length,
        replies: events.filter((e) => e.kind === 'reply').length,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('neural-memory endpoint failed', { err: msg });
    res.status(500).json({ error: msg });
  }
});
