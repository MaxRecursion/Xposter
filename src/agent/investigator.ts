import { getRepoRoot } from './repo_ops.js';
import { runAgent } from './runner.js';
import { INVESTIGATOR_SYSTEM_PROMPT, buildInvestigatorUserPrompt } from './prompts.js';
import { errorSignature } from './signature.js';
import {
  insertAgentRun, setAgentRunStatus,
  upsertInvestigation, setInvestigationStatus, getInvestigation,
  getRunCountToday,
} from './store.js';
import { getMaxRunsPerDay, assertAgentReady } from './client.js';
import { logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import type { ActivityRow, InvestigatorProposal, InvestigationRow } from './types.js';

/**
 * Investigator pipeline.
 *
 * - Takes a cluster of recurring activity_log error rows.
 * - Upserts an `agent_investigations` row keyed by error signature.
 * - Runs a Claude plan-mode agent against the live repo.
 * - Parses the final assistant message as JSON and stores it as the proposal.
 * - Transitions investigation status to PROPOSED on success, BLOCKED on parse fail.
 */

export async function runInvestigation(opts: {
  errors: ActivityRow[];
  trigger: 'watcher' | 'manual';
}): Promise<{ runId: string; investigation: InvestigationRow }> {
  if (opts.errors.length === 0) throw new Error('runInvestigation requires at least one error row');
  assertAgentReady();
  if (getRunCountToday() >= getMaxRunsPerDay()) {
    throw new Error(`daily agent run cap reached (${getMaxRunsPerDay()})`);
  }

  const sample = opts.errors[opts.errors.length - 1]; // most recent
  const signature = errorSignature(sample.event, sample.detail);

  const investigation = upsertInvestigation({
    signature,
    eventName: sample.event,
    sampleDetail: sample.detail,
    occurredAt: sample.created_at,
  });

  const cwd = getRepoRoot();
  const runId = insertAgentRun({
    mode: 'investigator',
    trigger: opts.trigger,
    cwd,
    sourceKind: 'investigation',
    sourceId: investigation.id,
  });

  setInvestigationStatus(investigation.id, 'OPEN', { run_id: runId });

  const userPrompt = buildInvestigatorUserPrompt(opts.errors, {
    occurrences: investigation.occurrences,
    signature,
  });

  // Fire and await — caller decides whether to await or detach.
  const result = await runAgent({
    runId,
    mode: 'investigator',
    cwd,
    prompt: userPrompt,
    systemPrompt: INVESTIGATOR_SYSTEM_PROMPT,
  });

  if (!result.ok) {
    setInvestigationStatus(investigation.id, 'BLOCKED', {
      summary: result.error ?? 'agent run failed',
    });
    return { runId, investigation: getInvestigation(investigation.id) ?? investigation };
  }

  const parsed = extractProposalJson(result.finalText);
  if (!parsed) {
    setInvestigationStatus(investigation.id, 'BLOCKED', {
      summary: `Could not parse JSON proposal. Raw output: ${result.finalText.slice(0, 400)}`,
    });
    setAgentRunStatus(runId, 'BLOCKED', { summary: 'JSON parse failed' });
    logEvent('AGENT_INVESTIGATION_BLOCKED', `run=${runId} reason=json_parse`);
    return { runId, investigation: getInvestigation(investigation.id) ?? investigation };
  }

  setInvestigationStatus(investigation.id, 'PROPOSED', {
    summary: parsed.summary,
    root_cause: parsed.root_cause,
    proposed_fix: JSON.stringify(parsed.proposed_fix),
    evidence_json: JSON.stringify(parsed.evidence ?? []),
  });

  logEvent('AGENT_INVESTIGATION_COMPLETE', parsed.summary.slice(0, 200));
  logger.info('Investigation proposal saved', {
    investigationId: investigation.id,
    confidence: parsed.confidence,
    files: parsed.proposed_fix.files_to_change,
  });

  return { runId, investigation: getInvestigation(investigation.id) ?? investigation };
}

/**
 * Robust JSON-block extraction. Strips ```json fences, finds the first `{`
 * and the matching last `}`, and parses. Validates against the required
 * top-level shape. Returns null on any failure.
 */
export function extractProposalJson(text: string): InvestigatorProposal | null {
  if (!text) return null;
  let s = text.trim();

  // Try fenced ```json ... ``` first
  const fence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fence?.[1]) s = fence[1].trim();

  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  const candidate = s.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.summary !== 'string' ||
    typeof p.root_cause !== 'string' ||
    !p.proposed_fix || typeof p.proposed_fix !== 'object'
  ) return null;
  const fix = p.proposed_fix as Record<string, unknown>;
  if (typeof fix.description !== 'string' || !Array.isArray(fix.files_to_change)) return null;

  return {
    summary: p.summary,
    root_cause: p.root_cause,
    evidence: Array.isArray(p.evidence) ? p.evidence as InvestigatorProposal['evidence'] : [],
    proposed_fix: {
      description: fix.description,
      files_to_change: (fix.files_to_change as unknown[]).map(String),
    },
    confidence: typeof p.confidence === 'number' ? p.confidence : 0,
  };
}
