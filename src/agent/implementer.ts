import { createAgentWorktree } from './worktree.js';
import { runAgent } from './runner.js';
import { IMPLEMENTER_SYSTEM_PROMPT, buildImplementerUserPrompt } from './prompts.js';
import {
  insertAgentRun, updateAgentRun,
  getInvestigation, setInvestigationStatus,
  getFeatureTask, setFeatureTaskStatus,
  getRunCountToday,
} from './store.js';
import { getMaxRunsPerDay, getBaseBranch, assertAgentReady } from './client.js';
import { logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import type { AgentRunRow, AgentSourceKind, InvestigationRow, FeatureTaskRow } from './types.js';

export type ImplementerSource =
  | { kind: 'investigation'; id: string }
  | { kind: 'feature'; id: string };

export interface ImplementerResult {
  runId: string;
  branch: string;
  worktreePath: string;
  prUrl: string | null;
  ok: boolean;
}

/**
 * Implementer pipeline.
 *
 * Steps:
 *   1. Look up the source row, validate it's in an applyable state.
 *   2. Check daily run cap.
 *   3. Create a fresh worktree off origin/<base> with branch agent/<short-id>.
 *   4. Run the implementer agent in that worktree.
 *   5. Heuristically extract a PR URL from the agent's final message.
 *   6. Mark the source row APPLIED / COMPLETED (or FAILED on agent error).
 */
export async function runImplementer(opts: {
  source: ImplementerSource;
  trigger: 'manual' | 'auto';
}): Promise<ImplementerResult> {
  assertAgentReady();

  if (getRunCountToday() >= getMaxRunsPerDay()) {
    throw new Error(`daily agent run cap reached (${getMaxRunsPerDay()})`);
  }

  let investigationRow: InvestigationRow | null = null;
  let featureRow: FeatureTaskRow | null = null;

  if (opts.source.kind === 'investigation') {
    investigationRow = getInvestigation(opts.source.id);
    if (!investigationRow) throw new Error(`investigation not found: ${opts.source.id}`);
    if (investigationRow.status !== 'PROPOSED') {
      throw new Error(`investigation must be PROPOSED to apply (currently ${investigationRow.status})`);
    }
  } else {
    featureRow = getFeatureTask(opts.source.id);
    if (!featureRow) throw new Error(`feature task not found: ${opts.source.id}`);
    if (featureRow.status !== 'SUBMITTED') {
      throw new Error(`feature task must be SUBMITTED to run (currently ${featureRow.status})`);
    }
  }

  // Pre-allocate run id so the worktree branch name (which uses the id) is stable.
  // We insert the run row AFTER the worktree exists, so the cwd field is correct.
  // To get a deterministic id pair, we create the worktree first using a uuid we generate.
  // Implementation: create the row WITHOUT a worktree path first to get the id;
  // then create the worktree using that id; then update the row's cwd/branch.

  const sourceKind: AgentSourceKind = opts.source.kind;
  const sourceId = opts.source.id;
  const placeholderRunId = insertAgentRun({
    mode: 'implementer',
    trigger: opts.trigger,
    cwd: '(pending worktree)',
    sourceKind,
    sourceId,
  });

  let worktree;
  try {
    worktree = await createAgentWorktree({ runId: placeholderRunId });
  } catch (err) {
    const msg = String(err);
    logger.error('Failed to create worktree', { err: msg });
    updateAgentRun(placeholderRunId, { error: msg, status: 'FAILED', finished_at: Math.floor(Date.now() / 1000) });
    logEvent('AGENT_WORKTREE_FAILED', msg);
    throw err;
  }

  updateAgentRun(placeholderRunId, { cwd: worktree.path, branch: worktree.branch });

  if (investigationRow) {
    setInvestigationStatus(investigationRow.id, 'PROPOSED', { run_id: placeholderRunId });
  } else if (featureRow) {
    setFeatureTaskStatus(featureRow.id, 'RUNNING', { run_id: placeholderRunId, branch: worktree.branch });
  }

  const userPrompt = buildImplementerUserPrompt(
    investigationRow ? { kind: 'investigation', row: investigationRow }
                     : { kind: 'feature', row: featureRow! },
    {
      branch: worktree.branch,
      baseBranch: getBaseBranch(),
      worktreePath: worktree.path,
    },
  );

  const result = await runAgent({
    runId: placeholderRunId,
    mode: 'implementer',
    cwd: worktree.path,
    prompt: userPrompt,
    systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
  });

  const prUrl = extractPrUrl(result.finalText);

  if (investigationRow) {
    if (result.ok && prUrl) {
      setInvestigationStatus(investigationRow.id, 'APPLIED', { run_id: placeholderRunId });
    } else if (!result.ok) {
      setInvestigationStatus(investigationRow.id, 'BLOCKED', {
        run_id: placeholderRunId,
        summary: `implementer failed: ${result.error ?? 'unknown'}`,
      });
    }
  } else if (featureRow) {
    setFeatureTaskStatus(
      featureRow.id,
      result.ok && prUrl ? 'COMPLETED' : 'FAILED',
      { run_id: placeholderRunId, branch: worktree.branch, pr_url: prUrl ?? undefined },
    );
  }

  logEvent('AGENT_IMPLEMENTATION_COMPLETE',
    `run=${placeholderRunId} branch=${worktree.branch} pr=${prUrl ?? 'none'} ok=${result.ok}`);

  return {
    runId: placeholderRunId,
    branch: worktree.branch,
    worktreePath: worktree.path,
    prUrl,
    ok: result.ok,
  };
}

/** Pulls a github.com/.../pull/<n> URL out of the agent's final message. */
export function extractPrUrl(text: string): string | null {
  if (!text) return null;
  const m = text.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
  return m?.[0] ?? null;
}
