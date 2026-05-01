import crypto from 'crypto';
import { getDb } from '../../storage/db.js';
import { logger } from '../../utils/logger.js';
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
  published_at: number | null;
  fetched_at: number;
  credibility: number;
}

export class ContextStore {
  constructor(private readonly embeddings: EmbeddingClient) {}

  /**
   * Insert items that aren't already stored (dedup by SHA-256 of body).
   * Embeds only the freshly-inserted items, then writes to the vec0 table.
   * Returns the number of items actually inserted.
   */
  async upsertAndEmbed(items: ContextItemInput[]): Promise<number> {
    if (items.length === 0) return 0;

    const db = getDb();
    const existsStmt = db.prepare('SELECT 1 AS hit FROM context_items WHERE body_hash = ?');

    const fresh = items
      .map((it) => ({
        ...it,
        bodyHash: crypto.createHash('sha256').update(it.body).digest('hex'),
      }))
      .filter((it) => !existsStmt.get(it.bodyHash));

    if (fresh.length === 0) {
      logger.debug('Context upsert: all duplicates', { source: items[0]?.source, count: items.length });
      return 0;
    }

    const texts = fresh.map((it) => buildEmbeddingInput(it.title, it.body));
    const vectors = await this.embeddings.embed(texts, { kind: 'document' });
    if (vectors.length !== fresh.length) {
      throw new Error(`Embedding count mismatch: got ${vectors.length} for ${fresh.length} items`);
    }

    const insertItem = db.prepare(`
      INSERT INTO context_items (
        id, source, source_url, title, body, body_hash, language, topics,
        published_at, fetched_at, expires_at, credibility
      ) VALUES (
        @id, @source, @sourceUrl, @title, @body, @bodyHash, @language, '[]',
        @publishedAt, @fetchedAt, @expiresAt, @credibility
      )
      ON CONFLICT(body_hash) DO NOTHING
    `);
    const insertVec = db.prepare('INSERT INTO vec_context(item_id, embedding) VALUES (?, ?)');

    const now = Math.floor(Date.now() / 1000);
    let inserted = 0;

    const tx = db.transaction((rows: typeof fresh, vecs: Float32Array[]) => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const id = r.bodyHash.slice(0, 32);
        const result = insertItem.run({
          id,
          source: r.source,
          sourceUrl: r.sourceUrl,
          title: r.title,
          body: r.body,
          bodyHash: r.bodyHash,
          language: r.language,
          publishedAt: r.publishedAt,
          fetchedAt: now,
          expiresAt: r.expiresAt,
          credibility: r.credibility,
        });
        if (result.changes === 1) {
          insertVec.run(id, Buffer.from(vecs[i].buffer, vecs[i].byteOffset, vecs[i].byteLength));
          inserted++;
        }
      }
    });
    tx(fresh, vectors);

    logger.info('Context upsert', {
      source: fresh[0]?.source,
      fresh: inserted,
      duplicates: items.length - inserted,
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
    // Over-fetch from KNN, then post-filter by recency. sqlite-vec MATCH wants `k = ?`.
    const rows = db.prepare(`
      SELECT v.item_id, v.distance, c.source, c.source_url, c.title, c.body,
             c.language, c.published_at, c.fetched_at, c.credibility
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
      publishedAt: r.published_at,
      fetchedAt: r.fetched_at,
      credibility: r.credibility,
      distance: r.distance,
    }));
  }

  /**
   * Delete items whose expires_at has passed. Also cleans the vec table.
   */
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
