import { getDb } from './db.js';

export interface ScheduledRun {
  id: number;
  run_date: string;
  run_at: number;
  kind: string;
  status: 'SCHEDULED' | 'FIRED' | 'SKIPPED' | 'ERROR';
  fired_at: number | null;
  detail: string | null;
}

export function insertScheduledRun(date: string, runAt: number, kind = 'PIPELINE', detail?: string): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO scheduled_runs (run_date, run_at, kind, detail) VALUES (?, ?, ?, ?)
  `).run(date, runAt, kind, detail ?? null);
}

export function getScheduledRunsForDate(date: string, kind = 'PIPELINE'): ScheduledRun[] {
  return getDb()
    .prepare(`SELECT * FROM scheduled_runs WHERE run_date = ? AND kind = ? ORDER BY run_at`)
    .all(date, kind) as ScheduledRun[];
}

/**
 * Due, unfired runs for a single day.
 *
 * `runDate` is required by every scheduler: without it a row left SCHEDULED by
 * an outage stays `run_at <= now` forever and replays on the next boot, days
 * later, publishing content researched for a date that has passed. Scoping the
 * query to one day makes a missed slot stay missed — `expireStaleScheduledRuns`
 * is what closes those rows out.
 */
export function getDuePendingRuns(now: number, kind = 'PIPELINE', runDate?: string): ScheduledRun[] {
  if (runDate === undefined) {
    return getDb()
      .prepare(`SELECT * FROM scheduled_runs WHERE status='SCHEDULED' AND run_at <= ? AND kind = ? ORDER BY run_at`)
      .all(now, kind) as ScheduledRun[];
  }
  return getDb()
    .prepare(`
      SELECT * FROM scheduled_runs
      WHERE status='SCHEDULED' AND run_at <= ? AND kind = ? AND run_date = ?
      ORDER BY run_at
    `)
    .all(now, kind, runDate) as ScheduledRun[];
}

/**
 * Closes out SCHEDULED rows left behind by earlier days (outage, machine
 * asleep, network drop mid-run) so they cannot fire retroactively.
 *
 * Returns the number of rows expired, so callers can log a real recovery
 * instead of silently swallowing it.
 */
export function expireStaleScheduledRuns(beforeDate: string, kind: string): number {
  const result = getDb().prepare(`
    UPDATE scheduled_runs
    SET status='SKIPPED',
        fired_at=unixepoch(),
        detail=COALESCE(detail || '; ', '') || 'expired: missed slot from ' || run_date
    WHERE status='SCHEDULED' AND kind = ? AND run_date < ?
  `).run(kind, beforeDate);
  return result.changes;
}

export function getUpcomingRuns(now: number, limit = 10, kind = 'PIPELINE'): ScheduledRun[] {
  return getDb()
    .prepare(`SELECT * FROM scheduled_runs WHERE status='SCHEDULED' AND run_at >= ? AND kind = ? ORDER BY run_at LIMIT ?`)
    .all(now, kind, limit) as ScheduledRun[];
}

export function markRunFired(id: number, detail?: string): void {
  getDb().prepare(`
    UPDATE scheduled_runs
    SET status='FIRED', fired_at=unixepoch(), detail=COALESCE(?, detail)
    WHERE id=?
  `).run(detail ?? null, id);
}

export function markRunSkipped(id: number, detail: string): void {
  getDb().prepare(`
    UPDATE scheduled_runs
    SET status='SKIPPED', fired_at=unixepoch(), detail=?
    WHERE id=?
  `).run(detail, id);
}

export function markRunError(id: number, detail: string): void {
  getDb().prepare(`
    UPDATE scheduled_runs
    SET status='ERROR', fired_at=unixepoch(), detail=?
    WHERE id=?
  `).run(detail, id);
}

/**
 * Puts a failed run back on the queue at a later time (transient browser/API
 * flake). Caps retries via a `retry=N` token in detail so a permanent failure
 * cannot loop forever.
 */
export function rescheduleRun(id: number, runAt: number, detail: string): void {
  getDb().prepare(`
    UPDATE scheduled_runs
    SET status='SCHEDULED', run_at=?, fired_at=NULL, detail=?
    WHERE id=?
  `).run(runAt, detail, id);
}

/** Parses `retry=N` from a detail string; defaults to 0. */
export function retryCountFromDetail(detail: string | null): number {
  if (!detail) return 0;
  const match = /(?:^|[|;,\s])retry=(\d+)/i.exec(detail);
  return match ? Number.parseInt(match[1], 10) || 0 : 0;
}

export function withRetryDetail(base: string, retries: number): string {
  const cleaned = base.replace(/(?:^|[|;,\s])retry=\d+/gi, '').trim().replace(/^[|;,\s]+|[|;,\s]+$/g, '');
  const prefix = cleaned ? `${cleaned}; ` : '';
  return `${prefix}retry=${retries}`;
}
