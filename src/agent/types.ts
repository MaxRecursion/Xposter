/**
 * Shared types for the Claude Agent SDK integration.
 *
 * Two run modes:
 *   investigator — read-only (permissionMode 'plan'); produces a JSON proposal
 *                  saved on an agent_investigations row.
 *   implementer  — read-write (permissionMode 'acceptEdits'); runs in a fresh
 *                  git worktree, edits files, runs tests, opens a PR via `gh`.
 */

export type AgentRunMode = 'investigator' | 'implementer';

export type AgentRunStatus =
  | 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'BLOCKED';

export type AgentRunTrigger = 'watcher' | 'manual' | 'auto';

export type InvestigationStatus =
  | 'OPEN' | 'PROPOSED' | 'APPLIED' | 'DISMISSED' | 'BLOCKED';

export type FeatureTaskStatus =
  | 'SUBMITTED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export type AgentSourceKind = 'investigation' | 'feature';

export interface AgentRunRow {
  id: string;
  mode: AgentRunMode;
  status: AgentRunStatus;
  trigger: AgentRunTrigger;
  model: string | null;
  cwd: string;
  branch: string | null;
  source_kind: AgentSourceKind | null;
  source_id: string | null;
  turn_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd_estimate: number | null;
  summary: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface InvestigationRow {
  id: string;
  signature: string;
  event_name: string;
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
  status: InvestigationStatus;
  run_id: string | null;
  summary: string | null;
  root_cause: string | null;
  proposed_fix: string | null;        // JSON-encoded
  evidence_json: string | null;       // JSON-encoded
  sample_detail: string | null;
  created_at: number;
  updated_at: number;
}

export interface FeatureTaskRow {
  id: string;
  title: string;
  description: string;
  requested_by: string;
  status: FeatureTaskStatus;
  run_id: string | null;
  branch: string | null;
  pr_url: string | null;
  created_at: number;
  updated_at: number;
}

/** Shape of the JSON the investigator agent is asked to emit as its final message. */
export interface InvestigatorProposal {
  summary: string;
  root_cause: string;
  evidence: Array<{ file: string; line?: number; quote?: string }>;
  proposed_fix: {
    description: string;
    files_to_change: string[];
  };
  confidence: number;
}

/** Activity-log row excerpt used by the watcher / investigator. */
export interface ActivityRow {
  id: number;
  post_id: string | null;
  event: string;
  detail: string | null;
  created_at: number;
}
