import { getDb } from './db.js';

export function logEvent(
  event: string,
  detail?: string,
  postId?: string,
): void {
  getDb()
    .prepare(`INSERT INTO activity_log (post_id, event, detail) VALUES (?, ?, ?)`)
    .run(postId ?? null, event, detail ?? null);
}

export function getActivityLog(limit = 100): Array<{
  id: number; post_id: string | null; event: string; detail: string | null; created_at: number;
}> {
  return getDb()
    .prepare(`SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Array<{
      id: number; post_id: string | null; event: string; detail: string | null; created_at: number;
    }>;
}
