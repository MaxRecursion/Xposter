import { getDb } from './db.js';
import { startOfLocalDayUnix } from '../utils/time.js';

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

export interface UpsertFollowerEventResult {
  id: number;
  created: boolean;
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

export function upsertPendingFollowBackEvent(
  handle: string,
  detail?: string,
): UpsertFollowerEventResult | null {
  const active = getDb().prepare(`
    SELECT id FROM follower_events
    WHERE account_handle = ?
      AND event_type = 'NEW_FOLLOWER'
      AND status IN ('PENDING','APPROVED')
    ORDER BY detected_at DESC
    LIMIT 1
  `).get(handle) as { id: number } | undefined;

  if (active) {
    getDb().prepare(`
      UPDATE follower_events
      SET status = 'PENDING',
          scheduled_at = NULL,
          action_taken_at = NULL,
          detail = COALESCE(?, detail)
      WHERE id = ?
    `).run(detail ?? null, active.id);
    return { id: active.id, created: false };
  }

  const resolved = getDb().prepare(`
    SELECT id FROM follower_events
    WHERE account_handle = ?
      AND event_type = 'NEW_FOLLOWER'
      AND status IN ('SKIPPED','ACTIONED')
    ORDER BY detected_at DESC
    LIMIT 1
  `).get(handle) as { id: number } | undefined;

  if (resolved) return null;

  const result = getDb().prepare(`
    INSERT INTO follower_events (account_handle, event_type, detail)
    VALUES (?, 'NEW_FOLLOWER', ?)
  `).run(handle, detail ?? null);
  return { id: result.lastInsertRowid as number, created: true };
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

export function listPendingFollowBackEvents(): FollowerEvent[] {
  return getDb().prepare(`
    SELECT fe.*
    FROM follower_events fe
    WHERE fe.event_type = 'NEW_FOLLOWER'
      AND fe.status = 'PENDING'
      AND instr(COALESCE(fe.detail, ''), 'relationship=not_followed_back') > 0
      AND EXISTS (
        SELECT 1
        FROM accounts a
        WHERE lower(a.handle) = lower(fe.account_handle)
          AND a.following_us = 1
          AND a.followed_by_us = 0
      )
    ORDER BY fe.detected_at DESC
    LIMIT 200
  `).all() as FollowerEvent[];
}

/**
 * Atomically move a PENDING event to APPROVED. Returns false when the event
 * was already handled (double tap / concurrent request), so only one caller
 * executes the follow action.
 */
export function claimFollowerEventForApproval(id: number): boolean {
  const result = getDb().prepare(`
    UPDATE follower_events
    SET status = 'APPROVED', action_taken_at = unixepoch()
    WHERE id = ? AND status = 'PENDING'
  `).run(id);
  return result.changes > 0;
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
      AND instr(COALESCE(detail, ''), 'auto_follow=true') > 0
    ORDER BY scheduled_at ASC
    LIMIT 10
  `).all(now) as FollowerEvent[];
}

export function countActionedFollowBacksToday(): number {
  const startOfDay = startOfLocalDayUnix();
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM follower_events
    WHERE event_type = 'NEW_FOLLOWER'
      AND status = 'ACTIONED'
      AND COALESCE(action_taken_at, 0) >= ?
  `).get(startOfDay) as { n: number };
  return row.n;
}
