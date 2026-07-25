/** DAL for the `image_posts` table. */
import crypto from 'crypto';
import { getDb } from './db.js';
import { logger } from '../utils/logger.js';

export type ImagePostStatus = 'PENDING' | 'POSTING' | 'POSTED' | 'ERROR' | 'SKIPPED' | 'REJECTED';

/** Statuses added after the original CHECK constraint shipped. */
const POST_HOC_STATUSES: ImagePostStatus[] = ['SKIPPED', 'REJECTED'];

export interface InsertImagePostInput {
  sceneId: string;
  prompt: string;
  revisedPrompt?: string | null;
  caption: string;
  filePath: string;
  model: string;
  seed: number;
  width: number;
  height: number;
  qaVerdict?: object | null;
  qaAttempts?: number;
}

export function insertImagePost(input: InsertImagePostInput): string {
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO image_posts (
      id, scene_id, prompt, revised_prompt, caption, file_path, model, status,
      seed, width, height, provider, qa_verdict, qa_attempts
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'POSTING', ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.sceneId, input.prompt, input.revisedPrompt ?? null, input.caption,
    input.filePath, input.model,
    input.seed, input.width, input.height,
    input.model.split(':')[0],
    input.qaVerdict ? JSON.stringify(input.qaVerdict) : null,
    input.qaAttempts ?? 0,
  );
  return id;
}

/**
 * Writes a terminal status.
 *
 * SKIPPED and REJECTED postdate the table's CHECK constraint, so on databases
 * created before this change they have to be written with the constraint
 * suspended — the same approach `markReplyDeleted()` uses in queries.ts.
 */
export function setImagePostStatus(id: string, status: ImagePostStatus, lastError?: string | null): void {
  const db = getDb();
  const needsBypass = POST_HOC_STATUSES.includes(status);

  const write = () => db.prepare(`
    UPDATE image_posts SET status = ?, last_error = COALESCE(?, last_error) WHERE id = ?
  `).run(status, lastError ?? null, id);

  if (!needsBypass) { write(); return; }

  db.pragma('ignore_check_constraints = ON');
  try {
    write();
  } finally {
    db.pragma('ignore_check_constraints = OFF');
  }
}

export function markImagePostPosted(id: string, tweetId: string | null, tweetUrl: string | null): void {
  getDb().prepare(`
    UPDATE image_posts
    SET status = 'POSTED', tweet_id = ?, tweet_url = ?, posted_at = unixepoch()
    WHERE id = ?
  `).run(tweetId, tweetUrl, id);
}

/**
 * Records a failure against the row.
 *
 * The previous scheduler only logged the error, leaving the row stuck in
 * POSTING forever — which is exactly how the one stranded row in production
 * happened.
 */
export function markImagePostError(id: string, err: unknown): void {
  setImagePostStatus(id, 'ERROR', String(err).slice(0, 500));
}

export function getRecentCaptions(limit: number): string[] {
  try {
    const rows = getDb().prepare(
      `SELECT caption FROM image_posts WHERE status = 'POSTED' ORDER BY posted_at DESC LIMIT ?`,
    ).all(limit) as Array<{ caption: string }>;
    return rows.map((r) => r.caption);
  } catch {
    return [];
  }
}

/**
 * Fails any row left mid-flight by a crash or restart, so it can't sit in
 * POSTING indefinitely. Called once at scheduler start.
 */
export function sweepStuckImagePosts(maxAgeSeconds = 3600): number {
  const db = getDb();
  db.pragma('ignore_check_constraints = ON');
  try {
    const result = db.prepare(`
      UPDATE image_posts
      SET status = 'ERROR', last_error = 'swept: stuck in POSTING'
      WHERE status = 'POSTING' AND created_at < unixepoch() - ?
    `).run(maxAgeSeconds);
    if (result.changes > 0) {
      logger.warn('Swept stuck image posts', { count: result.changes });
    }
    return result.changes;
  } finally {
    db.pragma('ignore_check_constraints = OFF');
  }
}

export function countImagePostsToday(): number {
  const startOfDay = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM image_posts
    WHERE created_at >= ? AND status IN ('POSTING','POSTED')
  `).get(startOfDay) as { n: number };
  return row.n;
}
