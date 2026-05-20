import crypto from 'crypto';
import { getDb } from '../../storage/db.js';
import { logger } from '../../utils/logger.js';
import { detectTopics, topicsAsJson } from '../topics.js';
import type { ContextItemInput, RetrievedContextItem } from '../types.js';
import type { EmbeddingClient } from '../embeddings/client.js';

interface RawHit {
  item_id: string;
  distance: number;
  source: string;
  source_url: string | null;
  title: string | null;
  body: string;
  language: string | null;
  topics: string;
  published_at: number | null;
  fetched_at: number;
  credibility: number;
}

const NEAR_DUPLICATE_DISTANCE = 0.06;
const NEAR_DUPLICATE_LOOKBACK_HOURS = 48;
const NEAR_DUPLICATE_K = 5;

export class ContextStore {
  constructor(private readonly embeddings: EmbeddingClient) {}

  /**
   * Insert items that aren't already stored. Two-stage dedup:
   *   1. SHA-256 of body — exact duplicate detection (cheap, no embedding spent)
   *   2. Cosine distance against recent items — semantic near-duplicate
   * Returns the number of items actually inserted.
   */
  async upsertAndEmbed(items: ContextItemInput[]): Promise<number> {
    if (items.length === 0) return 0;

    const db = getDb();
    const existsStmt = db.prepare('SELECT 1 AS hit FROM context_items WHERE body_hash = ?');

    const seenHashes = new Set<string>();
    const hashFresh = items
      .map((it) => ({
        ...it,
        bodyHash: crypto.createHash('sha256').update(it.body).digest('hex'),
      }))
      .filter((it) => {
        if (seenHashes.has(it.bodyHash)) return false;
        seenHashes.add(it.bodyHash);
        return !existsStmt.get(it.bodyHash);
      });

    if (hashFresh.length === 0) {
      logger.debug('Context upsert: all hash-duplicates', { source: items[0]?.source, count: items.length });
      return 0;
    }

    const texts = hashFresh.map((it) => buildEmbeddingInput(it.title, it.body));
    const vectors = await this.embeddings.embed(texts, { kind: 'document' });
    if (vectors.length !== hashFresh.length) {
      throw new Error(`Embedding count mismatch: got ${vectors.length} for ${hashFresh.length} items`);
    }

    const insertItem = db.prepare(`
      INSERT INTO context_items (
        id, source, source_url, title, body, body_hash, language, topics,
        published_at, fetched_at, expires_at, credibility
      ) VALUES (
        @id, @source, @sourceUrl, @title, @body, @bodyHash, @language, @topics,
        @publishedAt, @fetchedAt, @expiresAt, @credibility
      )
      ON CONFLICT(body_hash) DO NOTHING
    `);
    const insertVec = db.prepare('INSERT INTO vec_context(item_id, embedding) VALUES (?, ?)');
    const cutoff = Math.floor(Date.now() / 1000) - NEAR_DUPLICATE_LOOKBACK_HOURS * 3600;
    const nearDupStmt = db.prepare(`
      SELECT v.item_id, v.distance, c.published_at
      FROM vec_context v
      JOIN context_items c ON c.id = v.item_id
      WHERE v.embedding MATCH ? AND k = ?
        AND (c.published_at IS NULL OR c.published_at >= ?)
      ORDER BY v.distance
      LIMIT 1
    `);

    const now = Math.floor(Date.now() / 1000);
    let inserted = 0;
    let nearDupSkipped = 0;

    const tx = db.transaction((rows: typeof hashFresh, vecs: Float32Array[]) => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const vec = vecs[i];
        const vbuf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);

        // Cosine near-duplicate check
        const hit = nearDupStmt.get(vbuf, NEAR_DUPLICATE_K, cutoff) as { distance: number } | undefined;
        if (hit && hit.distance < NEAR_DUPLICATE_DISTANCE) {
          nearDupSkipped++;
          continue;
        }

        const id = r.bodyHash.slice(0, 32);
        const topics = detectTopics(`${r.title ?? ''} ${r.body}`);
        const result = insertItem.run({
          id,
          source: r.source,
          sourceUrl: r.sourceUrl,
          title: r.title,
          body: r.body,
          bodyHash: r.bodyHash,
          language: r.language,
          topics: topicsAsJson(topics),
          publishedAt: r.publishedAt,
          fetchedAt: now,
          expiresAt: r.expiresAt,
          credibility: r.credibility,
        });
        if (result.changes === 1) {
          insertVec.run(id, vbuf);
          inserted++;
        }
      }
    });
    tx(hashFresh, vectors);

    logger.info('Context upsert', {
      source: hashFresh[0]?.source,
      attempted: hashFresh.length,
      inserted,
      hashDuplicates: items.length - hashFresh.length,
      nearDuplicates: nearDupSkipped,
    });
    return inserted;
  }

  async semanticSearch(
    query: string,
    opts: { k?: number; maxAgeSeconds?: number; language?: string | null } = {},
  ): Promise<RetrievedContextItem[]> {
    const k = Math.max(1, opts.k ?? 8);
    const maxAge = opts.maxAgeSeconds ?? 36 * 3600;

    const [qvec] = await this.embeddings.embed([query], { kind: 'query' });
    if (!qvec) return [];
    const qbuf = Buffer.from(qvec.buffer, qvec.byteOffset, qvec.byteLength);
    const cutoff = Math.floor(Date.now() / 1000) - maxAge;

    const db = getDb();
    const rows = db.prepare(`
      SELECT v.item_id, v.distance, c.source, c.source_url, c.title, c.body,
             c.language, c.topics, c.published_at, c.fetched_at, c.credibility
      FROM vec_context v
      JOIN context_items c ON c.id = v.item_id
      WHERE v.embedding MATCH ? AND k = ?
        AND (c.published_at IS NULL OR c.published_at >= ?)
      ORDER BY v.distance
    `).all(qbuf, k * 4, cutoff) as RawHit[];

    return rows.slice(0, k).map((r) => ({
      itemId: r.item_id,
      source: r.source,
      sourceUrl: r.source_url,
      title: r.title,
      body: r.body,
      language: r.language,
      topics: r.topics,
      publishedAt: r.published_at,
      fetchedAt: r.fetched_at,
      credibility: r.credibility,
      distance: r.distance,
    }));
  }

  /** Delete items whose expires_at has passed, and their vectors. */
  pruneExpired(): number {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const ids = db.prepare(
      'SELECT id FROM context_items WHERE expires_at IS NOT NULL AND expires_at < ?',
    ).all(now) as Array<{ id: string }>;
    if (ids.length === 0) return 0;

    const delItem = db.prepare('DELETE FROM context_items WHERE id = ?');
    const delVec = db.prepare('DELETE FROM vec_context WHERE item_id = ?');
    const tx = db.transaction((rows: Array<{ id: string }>) => {
      for (const row of rows) {
        delVec.run(row.id);
        delItem.run(row.id);
      }
    });
    tx(ids);
    logger.info('Context prune', { removed: ids.length });
    return ids.length;
  }
}

function buildEmbeddingInput(title: string | null, body: string): string {
  return title ? `${title}\n\n${body}` : body;
}
