import { getDb } from './db.js';

export type FollowerEventType = 'NEW_FOLLOWER' | 'UNFOLLOWED' | 'FOLLOW_BACK_DUE';
export type FollowerEventStatus =
  | 'PENDING' | 'APPROVED' | 'ACTIONED' | 'SKIPPED' | 'ERROR' | 'EXPIRED';

export interface FollowerEvent {
  id: number;
  account_handle: string;
  event_type: FollowerEventType;
  status: FollowerEventStatus;
  detected_at: number;
  action_taken_at: number | null;
  scheduled_at: number | null;
  detail: string | null;
}

export function enqueueFollowerEvent(
  handle: string,
  type: FollowerEventType,
  detail?: string,
): number | null {
  const existing = getDb().prepare(`
    SELECT id FROM follower_events
    WHERE account_handle = ? AND event_type = ? AND status IN ('PENDING','APPROVED')
  `).get(handle, type) as { id: number } | undefined;
  if (existing) return null;

  const result = getDb().prepare(`
    INSERT INTO follower_events (account_handle, event_type, detail) VALUES (?, ?, ?)
  `).run(handle, type, detail ?? null);
  return result.lastInsertRowid as number;
}

export function getFollowerEvent(id: number): FollowerEvent | null {
  return (getDb()
    .prepare('SELECT * FROM follower_events WHERE id = ?')
    .get(id) as FollowerEvent | undefined) ?? null;
}

export function listFollowerEvents(status?: FollowerEventStatus): FollowerEvent[] {
  if (status) {
    return getDb()
      .prepare(`SELECT * FROM follower_events WHERE status = ? ORDER BY detected_at DESC LIMIT 200`)
      .all(status) as FollowerEvent[];
  }
  return getDb()
    .prepare(`SELECT * FROM follower_events ORDER BY detected_at DESC LIMIT 200`)
    .all() as FollowerEvent[];
}

export function setFollowerEventStatus(
  id: number,
  status: FollowerEventStatus,
  detail?: string,
): void {
  getDb().prepare(`
    UPDATE follower_events
    SET status = ?, action_taken_at = unixepoch(),
        detail = COALESCE(?, detail)
    WHERE id = ?
  `).run(status, detail ?? null, id);
}

/**
 * Auto-approve a NEW_FOLLOWER event and set a scheduled_at time for execution.
 * The background processor will execute the follow when scheduled_at passes.
 */
export function autoApproveFollowBack(id: number, scheduledAt: number, detail?: string): void {
  getDb().prepare(`
    UPDATE follower_events
    SET status = 'APPROVED', scheduled_at = ?, detail = COALESCE(?, detail)
    WHERE id = ?
  `).run(scheduledAt, detail ?? null, id);
}

/**
 * Returns all APPROVED events whose scheduled_at has arrived (i.e. ready to execute).
 */
export function getDueScheduledFollowBacks(): FollowerEvent[] {
  const now = Math.floor(Date.now() / 1000);
  return getDb().prepare(`
    SELECT * FROM follower_events
    WHERE status = 'APPROVED'
      AND scheduled_at IS NOT NULL
      AND scheduled_at <= ?
    ORDER BY scheduled_at ASC
    LIMIT 10
  `).all(now) as FollowerEvent[];
}

export function countActionedFollowBacksToday(): number {
  const startOfDay = startOfTodayUnix();
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM follower_events
    WHERE event_type = 'NEW_FOLLOWER'
      AND status = 'ACTIONED'
      AND COALESCE(action_taken_at, 0) >= ?
  `).get(startOfDay) as { n: number };
  return row.n;
}

function startOfTodayUnix(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor(start.getTime() / 1000);
}
