/**
 * Cache of style-anchor images uploaded to a provider's file storage.
 *
 * Anchors are static files that change rarely, but a naive implementation
 * would re-upload all three on every generation — or inline them as base64,
 * adding megabytes to each request. Caching by content hash means an upload
 * happens only when an anchor's bytes actually change.
 *
 * Every function swallows its errors and returns a neutral value, matching
 * image_budget.ts: bookkeeping must never break generation.
 */
import crypto from 'crypto';
import { getDb } from './db.js';
import { logger } from '../utils/logger.js';

export function hashBuffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Returns a cached upload URL, or null on a miss or once past the TTL.
 *
 * The TTL exists because provider file-retention policies are undocumented; a
 * silently expired URL would produce a bad image that still bills. Re-uploading
 * a 60KB file monthly costs nothing.
 */
export function lookupUpload(provider: string, hash: string, ttlDays: number): string | null {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - ttlDays * 86_400;
    const row = getDb().prepare(`
      SELECT url FROM image_ref_uploads
      WHERE provider = ? AND hash = ? AND created_at >= ?
    `).get(provider, hash, cutoff) as { url: string } | undefined;
    return row?.url ?? null;
  } catch {
    return null;
  }
}

export function rememberUpload(
  provider: string,
  hash: string,
  url: string,
  bytes?: number,
  contentType?: string,
): void {
  try {
    getDb().prepare(`
      INSERT INTO image_ref_uploads (provider, hash, url, bytes, content_type)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, hash) DO UPDATE SET
        url = excluded.url,
        bytes = excluded.bytes,
        content_type = excluded.content_type,
        created_at = unixepoch()
    `).run(provider, hash, url, bytes ?? null, contentType ?? null);
  } catch (err) {
    logger.warn('Failed to cache reference upload', { err: String(err).slice(0, 200) });
  }
}

export function countUploads(provider: string): number {
  try {
    const row = getDb().prepare(
      'SELECT COUNT(*) AS n FROM image_ref_uploads WHERE provider = ?',
    ).get(provider) as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

/** Drops cached uploads, forcing a re-upload on the next generation. */
export function purgeUploads(provider?: string): number {
  try {
    const result = provider
      ? getDb().prepare('DELETE FROM image_ref_uploads WHERE provider = ?').run(provider)
      : getDb().prepare('DELETE FROM image_ref_uploads').run();
    return result.changes;
  } catch {
    return 0;
  }
}
