import { execFileSync } from 'child_process';
import { getSetting } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import type { AgentRunMode } from './types.js';

/**
 * Readiness + env-config helpers for the Claude Agent SDK integration.
 *
 * The SDK spawns the local Claude Code CLI to authenticate — there is no
 * API key in .env. We just need `claude` on PATH and `gh` for PR creation.
 *
 * Master enable/disable lives in the DB `settings` table under
 * `agent_enabled`. Env var `AGENT_ENABLED` is an optional hard infra kill
 * switch (defaults to true) — when it's explicitly 'false', the whole
 * subsystem is inert regardless of the user toggle.
 */

let _claudeChecked = false;
let _claudeFound = false;
let _ghChecked = false;
let _ghFound = false;

export function isAgentEnabled(): boolean {
  // Hard infra-level kill: if AGENT_ENABLED is explicitly 'false', off everywhere.
  if ((process.env.AGENT_ENABLED ?? 'true').toLowerCase() === 'false') return false;
  // User-facing toggle from the dashboard Settings tab.
  return getSetting('agent_enabled', 'false') === 'true';
}

export function getAgentModel(): string {
  return process.env.AGENT_MODEL ?? 'claude-sonnet-4-5';
}

export function getMaxTurnsPerRun(mode: AgentRunMode): number {
  const fallback = mode === 'investigator' ? '30' : '60';
  const key = mode === 'investigator'
    ? 'AGENT_INVESTIGATOR_MAX_TURNS'
    : 'AGENT_IMPLEMENTER_MAX_TURNS';
  const n = parseInt(process.env[key] ?? fallback, 10);
  return Number.isFinite(n) && n > 0 ? n : parseInt(fallback, 10);
}

export function getMaxRunsPerDay(): number {
  const n = parseInt(process.env.AGENT_MAX_RUNS_PER_DAY ?? '10', 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

export function getWatchIntervalMs(): number {
  const n = parseInt(process.env.AGENT_WATCH_INTERVAL_MS ?? '300000', 10);
  return Number.isFinite(n) && n >= 30_000 ? n : 300_000;
}

export function getErrorThreshold(): number {
  const settingVal = getSetting('agent_error_threshold', '3');
  const n = parseInt(settingVal, 10);
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

export function getBaseBranch(): string {
  return process.env.AGENT_BASE_BRANCH ?? 'main';
}

export function getAllowWeb(): boolean {
  return (process.env.AGENT_ALLOW_WEB ?? 'false').toLowerCase() === 'true';
}

const DEFAULT_DISALLOWED_PATHS = ['.env', '.env.local', 'data/', 'browser-profile/', 'logs/'];

export function getDisallowedPaths(): string[] {
  const extra = (process.env.AGENT_DISALLOWED_PATHS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_DISALLOWED_PATHS, ...extra])];
}

export function isClaudeCliFound(): boolean {
  if (!_claudeChecked) {
    _claudeChecked = true;
    try {
      execFileSync('which', ['claude'], { stdio: 'pipe' });
      _claudeFound = true;
    } catch {
      _claudeFound = false;
    }
  }
  return _claudeFound;
}

export function isGhCliFound(): boolean {
  if (!_ghChecked) {
    _ghChecked = true;
    try {
      execFileSync('which', ['gh'], { stdio: 'pipe' });
      _ghFound = true;
    } catch {
      _ghFound = false;
    }
  }
  return _ghFound;
}

/** Reset the cached CLI lookups — used by tests / a re-check endpoint. */
export function resetCliCache(): void {
  _claudeChecked = false;
  _ghChecked = false;
}

/**
 * Throws if the agent isn't ready to run.
 *
 * Reasons:
 *   - infra kill switch (`AGENT_ENABLED=false` in env)
 *   - user toggle off (`agent_enabled` setting)
 *   - `claude` CLI missing
 */
export function assertAgentReady(): void {
  if ((process.env.AGENT_ENABLED ?? 'true').toLowerCase() === 'false') {
    throw new Error('Agent is disabled at the infrastructure level (AGENT_ENABLED=false).');
  }
  if (getSetting('agent_enabled', 'false') !== 'true') {
    throw new Error('Agent is disabled in dashboard settings. Toggle it on under Settings → Agent.');
  }
  if (!isClaudeCliFound()) {
    throw new Error('`claude` (Claude Code CLI) not found on PATH. Install it from https://claude.com/code.');
  }
}

/**
 * Lazy import of the SDK so a missing optional dep doesn't crash boot.
 * Returns the `query` function from `@anthropic-ai/claude-agent-sdk`.
 */
type SdkQueryFn = (input: unknown) => AsyncIterable<unknown>;
let _query: SdkQueryFn | null = null;

export async function getQueryFn(): Promise<SdkQueryFn> {
  if (_query) return _query;
  try {
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    if (typeof (mod as { query?: unknown }).query !== 'function') {
      throw new Error('SDK module did not export a `query` function');
    }
    _query = (mod as unknown as { query: SdkQueryFn }).query;
    return _query;
  } catch (err) {
    logger.error('Failed to load @anthropic-ai/claude-agent-sdk', { err: String(err) });
    throw new Error('@anthropic-ai/claude-agent-sdk could not be loaded. Run `npm install` first.');
  }
}
