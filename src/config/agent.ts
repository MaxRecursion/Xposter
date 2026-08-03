import { parseBool, parseIntValue } from './parse.js';

export function isAgentInfraEnabled(): boolean {
  return parseBool(process.env.AGENT_ENABLED, true);
}

export function getAgentModel(): string {
  return process.env.AGENT_MODEL?.trim() || 'claude-sonnet-4-5';
}

export function getAgentMaxRunsPerDay(): number {
  return parseIntValue(process.env.AGENT_MAX_RUNS_PER_DAY, 10, 0);
}

export function getAgentWatchIntervalMs(): number {
  return parseIntValue(process.env.AGENT_WATCH_INTERVAL_MS, 300_000, 30_000);
}

export function getAgentBaseBranch(): string {
  return process.env.AGENT_BASE_BRANCH?.trim() || 'main';
}

export function getAllowAgentWeb(): boolean {
  return parseBool(process.env.AGENT_ALLOW_WEB, false);
}

export function getAgentCliPath(): string | null {
  return process.env.CLAUDE_CLI_PATH?.trim() || null;
}

export function getAgentInvestigatorMaxTurns(): number {
  return parseIntValue(process.env.AGENT_INVESTIGATOR_MAX_TURNS, 30, 1);
}

export function getAgentImplementerMaxTurns(): number {
  return parseIntValue(process.env.AGENT_IMPLEMENTER_MAX_TURNS, 60, 1);
}

export function getAgentDisallowedPaths(): string[] {
  const extra = (process.env.AGENT_DISALLOWED_PATHS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(['.env', '.env.local', 'data/', 'browser-profile/', 'logs/', ...extra])];
}
