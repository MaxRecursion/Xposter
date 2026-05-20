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

export function getDuePendingRuns(now: number, kind = 'PIPELINE'): ScheduledRun[] {
  return getDb()
    .prepare(`SELECT * FROM scheduled_runs WHERE status='SCHEDULED' AND run_at <= ? AND kind = ? ORDER BY run_at`)
    .all(now, kind) as ScheduledRun[];
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
