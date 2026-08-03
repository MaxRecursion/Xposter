import crypto from 'crypto';
import { getDb } from '../storage/db.js';
import type {
  AgentRunRow, AgentRunMode, AgentRunStatus, AgentRunTrigger, AgentSourceKind,
  InvestigationRow, InvestigationStatus,
  FeatureTaskRow, FeatureTaskStatus,
  ActivityRow,
} from './types.js';
import { startOfLocalDayUnix } from '../utils/time.js';

// ── agent_runs ────────────────────────────────────────────────────────────────

export function insertAgentRun(opts: {
  mode: AgentRunMode;
  trigger: AgentRunTrigger;
  cwd: string;
  branch?: string | null;
  model?: string | null;
  sourceKind?: AgentSourceKind | null;
  sourceId?: string | null;
}): string {
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO agent_runs (id, mode, status, trigger, model, cwd, branch, source_kind, source_id)
    VALUES (?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?)
  `).run(
    id, opts.mode, opts.trigger,
    opts.model ?? null, opts.cwd, opts.branch ?? null,
    opts.sourceKind ?? null, opts.sourceId ?? null,
  );
  return id;
}

export function updateAgentRun(
  id: string,
  patch: Partial<Pick<AgentRunRow,
    'status' | 'turn_count' | 'input_tokens' | 'output_tokens' |
    'cache_read_tokens' | 'cache_creation_tokens' | 'cost_usd_estimate' |
    'summary' | 'error' | 'finished_at' | 'branch' | 'cwd' | 'model'
  >>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    values.push(v);
  }
  if (fields.length === 0) return;
  values.push(id);
  getDb().prepare(`UPDATE agent_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function setAgentRunStatus(id: string, status: AgentRunStatus, extra?: { summary?: string; error?: string }): void {
  const finished = status === 'SUCCESS' || status === 'FAILED' || status === 'CANCELLED' || status === 'BLOCKED';
  updateAgentRun(id, {
    status,
    summary: extra?.summary,
    error: extra?.error,
    finished_at: finished ? Math.floor(Date.now() / 1000) : undefined,
  });
}

export function getAgentRun(id: string): AgentRunRow | null {
  return (getDb()
    .prepare(`SELECT * FROM agent_runs WHERE id = ?`)
    .get(id) as AgentRunRow | undefined) ?? null;
}

export function listAgentRuns(limit = 50): AgentRunRow[] {
  return getDb()
    .prepare(`SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?`)
    .all(Math.min(Math.max(limit, 1), 500)) as AgentRunRow[];
}

export function getRunCountToday(): number {
  const startOfDay = startOfLocalDayUnix();
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM agent_runs WHERE started_at >= ?
  `).get(startOfDay) as { n: number };
  return row.n;
}

// ── agent_investigations ──────────────────────────────────────────────────────

export function findOpenInvestigationBySignature(signature: string): InvestigationRow | null {
  return (getDb()
    .prepare(`SELECT * FROM agent_investigations WHERE signature = ?`)
    .get(signature) as InvestigationRow | undefined) ?? null;
}

export function upsertInvestigation(opts: {
  signature: string;
  eventName: string;
  sampleDetail: string | null;
  occurredAt: number;
}): InvestigationRow {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM agent_investigations WHERE signature = ?`)
    .get(opts.signature) as InvestigationRow | undefined;

  if (existing) {
    db.prepare(`
      UPDATE agent_investigations
      SET occurrences = occurrences + 1,
          last_seen_at = MAX(last_seen_at, ?),
          updated_at = unixepoch()
      WHERE signature = ?
    `).run(opts.occurredAt, opts.signature);
    return db.prepare(`SELECT * FROM agent_investigations WHERE signature = ?`)
      .get(opts.signature) as InvestigationRow;
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO agent_investigations
      (id, signature, event_name, occurrences, first_seen_at, last_seen_at, sample_detail)
    VALUES (?, ?, ?, 1, ?, ?, ?)
  `).run(id, opts.signature, opts.eventName, opts.occurredAt, opts.occurredAt, opts.sampleDetail);
  return db.prepare(`SELECT * FROM agent_investigations WHERE id = ?`)
    .get(id) as InvestigationRow;
}

export function setInvestigationStatus(
  id: string,
  status: InvestigationStatus,
  patch: Partial<Pick<InvestigationRow, 'run_id' | 'summary' | 'root_cause' | 'proposed_fix' | 'evidence_json'>> = {},
): void {
  const fields = ['status = ?', 'updated_at = unixepoch()'];
  const values: unknown[] = [status];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  getDb().prepare(`UPDATE agent_investigations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getInvestigation(id: string): InvestigationRow | null {
  return (getDb()
    .prepare(`SELECT * FROM agent_investigations WHERE id = ?`)
    .get(id) as InvestigationRow | undefined) ?? null;
}

export function listInvestigations(opts: { status?: InvestigationStatus; limit?: number } = {}): InvestigationRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  if (opts.status) {
    return getDb().prepare(`
      SELECT * FROM agent_investigations WHERE status = ? ORDER BY last_seen_at DESC LIMIT ?
    `).all(opts.status, limit) as InvestigationRow[];
  }
  return getDb().prepare(`
    SELECT * FROM agent_investigations ORDER BY last_seen_at DESC LIMIT ?
  `).all(limit) as InvestigationRow[];
}

// ── agent_feature_tasks ───────────────────────────────────────────────────────

export function insertFeatureTask(opts: {
  title: string;
  description: string;
  requestedBy?: string;
}): FeatureTaskRow {
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO agent_feature_tasks (id, title, description, requested_by)
    VALUES (?, ?, ?, ?)
  `).run(id, opts.title, opts.description, opts.requestedBy ?? 'dashboard');
  return getFeatureTask(id)!;
}

export function setFeatureTaskStatus(
  id: string,
  status: FeatureTaskStatus,
  patch: Partial<Pick<FeatureTaskRow, 'run_id' | 'branch' | 'pr_url'>> = {},
): void {
  const fields = ['status = ?', 'updated_at = unixepoch()'];
  const values: unknown[] = [status];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  getDb().prepare(`UPDATE agent_feature_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getFeatureTask(id: string): FeatureTaskRow | null {
  return (getDb()
    .prepare(`SELECT * FROM agent_feature_tasks WHERE id = ?`)
    .get(id) as FeatureTaskRow | undefined) ?? null;
}

export function listFeatureTasks(opts: { status?: FeatureTaskStatus; limit?: number } = {}): FeatureTaskRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  if (opts.status) {
    return getDb().prepare(`
      SELECT * FROM agent_feature_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?
    `).all(opts.status, limit) as FeatureTaskRow[];
  }
  return getDb().prepare(`
    SELECT * FROM agent_feature_tasks ORDER BY created_at DESC LIMIT ?
  `).all(limit) as FeatureTaskRow[];
}

// ── activity_log query for the watcher ────────────────────────────────────────

export function getActivityRowsSince(
  sinceUnix: number,
  eventNames: string[],
): ActivityRow[] {
  if (eventNames.length === 0) return [];
  const placeholders = eventNames.map(() => '?').join(', ');
  return getDb().prepare(`
    SELECT id, post_id, event, detail, created_at FROM activity_log
    WHERE created_at >= ? AND event IN (${placeholders})
    ORDER BY created_at ASC
  `).all(sinceUnix, ...eventNames) as ActivityRow[];
}
