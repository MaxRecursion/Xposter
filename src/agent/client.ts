import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { getSetting } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import type { AgentRunMode } from './types.js';
import {
  isAgentInfraEnabled as isAgentInfraEnabledConfig,
  getAgentModel as getConfigAgentModel,
  getAgentMaxRunsPerDay,
  getAgentWatchIntervalMs,
  getAgentBaseBranch,
  getAllowAgentWeb,
  getAgentCliPath,
  getAgentInvestigatorMaxTurns,
  getAgentImplementerMaxTurns,
  getAgentDisallowedPaths,
} from '../config.js';

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
let _claudePath: string | null = null;
let _ghChecked = false;
let _ghFound = false;

export function isAgentEnabled(): boolean {
  if (!isAgentInfraEnabled()) return false;
  return getSetting('agent_enabled', 'false') === 'true';
}

export function isAgentInfraEnabled(): boolean {
  return isAgentInfraEnabledConfig();
}

export function getAgentModel(): string {
  return getConfigAgentModel();
}

export function getMaxTurnsPerRun(mode: AgentRunMode): number {
  return mode === 'investigator'
    ? getAgentInvestigatorMaxTurns()
    : getAgentImplementerMaxTurns();
}

export function getMaxRunsPerDay(): number {
  return getAgentMaxRunsPerDay();
}

export function getWatchIntervalMs(): number {
  return getAgentWatchIntervalMs();
}

export function getErrorThreshold(): number {
  const settingVal = getSetting('agent_error_threshold', '3');
  const n = parseInt(settingVal, 10);
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

export function getBaseBranch(): string {
  return getAgentBaseBranch();
}

export function getAllowWeb(): boolean {
  return getAllowAgentWeb();
}

export function getDisallowedPaths(): string[] {
  return getAgentDisallowedPaths();
}

/** Ordered list of absolute paths to check when `which claude` fails (e.g. nohup PATH). */
const CLAUDE_FALLBACK_PATHS = [
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
  `${os.homedir()}/.local/bin/claude`,
  '/Users/akshaykulkarni/.local/bin/claude',
  '/Users/akshaykulkarni/.npm-global/bin/claude',
];

function resolveClaude(): string | null {
  // 1. Explicit env override
  const cliPath = getAgentCliPath();
  if (cliPath) return cliPath;
  // 2. which (works when PATH is full, e.g. interactive shell)
  try {
    const p = execFileSync('which', ['claude'], { stdio: 'pipe' }).toString().trim();
    if (p) return p;
  } catch { /* fall through */ }
  // 3. Known absolute paths
  for (const p of CLAUDE_FALLBACK_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function isClaudeCliFound(): boolean {
  if (!_claudeChecked) {
    _claudeChecked = true;
    _claudePath = resolveClaude();
    _claudeFound = _claudePath !== null;
    if (_claudeFound) {
      logger.info('Claude CLI found', { path: _claudePath });
    } else {
      logger.warn('Claude CLI not found on PATH or common install locations');
    }
  }
  return _claudeFound;
}

/** Returns the resolved absolute path to the claude binary, or null if not found. */
export function getClaudePath(): string | null {
  if (!_claudeChecked) isClaudeCliFound();
  return _claudePath;
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
  _claudePath = null;
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
  if (!isAgentInfraEnabled()) {
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
