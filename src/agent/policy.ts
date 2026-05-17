import path from 'path';
import { getAllowWeb, getDisallowedPaths } from './client.js';
import { logger } from '../utils/logger.js';
import { logEvent } from '../storage/queries.js';
import type { AgentRunMode } from './types.js';

/**
 * `canUseTool` policy for both agent modes.
 *
 * Defense in depth — the SDK's `permissionMode: 'plan'` already blocks writes
 * for the investigator, but we re-check every tool call to:
 *   1. Catch SDK behavior drift on future versions.
 *   2. Block destructive Bash patterns the SDK doesn't model (rm, force-push, etc.).
 *   3. Block writes to `.env`, `data/`, `browser-profile/`, `logs/` for BOTH modes.
 *
 * The callback shape matches the SDK's expected signature: it returns either
 *   { behavior: 'allow', updatedInput: input }  →  proceed
 *   { behavior: 'deny',  message }              →  blocked, agent sees message
 */

type ToolInput = Record<string, unknown>;

interface PolicyDecision {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: ToolInput;
}

export type CanUseToolFn = (
  toolName: string,
  input: ToolInput,
) => Promise<PolicyDecision> | PolicyDecision;

const READONLY_BASH_PREFIXES = [
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'which', 'whoami',
  'grep', 'rg', 'find', 'awk', 'sed -n', 'sort', 'uniq', 'tr', 'cut',
  'node --version', 'npm --version', 'npx tsc --noEmit', 'npx tsc --version',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git remote',
  'git rev-parse', 'git worktree list', 'git config --get',
  'jq', 'env', 'date', 'uname',
];

const IMPLEMENTER_WRITE_BASH_ALLOWED = [
  ...READONLY_BASH_PREFIXES,
  'npm test', 'npm run build', 'npm run lint', 'npx tsc',
  'npx vitest', 'npx eslint',
  'git add', 'git commit', 'git checkout', 'git switch', 'git restore',
  'git stash', 'git fetch', 'git pull --ff-only',
  'gh pr create', 'gh pr view', 'gh repo view',
];

const FORBIDDEN_BASH_PATTERNS: RegExp[] = [
  /\brm\s+-[a-zA-Z]*r/i,                           // rm -rf
  /\brm\b.*\b(\.env|data\/|browser-profile\/|logs\/)/i,
  /\bsudo\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bcurl\s+.*\b-X\s+(POST|PUT|DELETE|PATCH)/i,    // network mutations
  /\bwget\s+/i,
  /\bnpm\s+(install|i|uninstall|update)\b/i,       // dep changes — needs human review
  /\bpip\s+install\b/i,
  /\bbrew\s+(install|uninstall)\b/i,
  /\bnpx\s+--package\b/i,                          // arbitrary package execution
  /\bgit\s+push\s+.*\bmain\b/i,                    // never push to main
  /\bgit\s+push\s+.*\bmaster\b/i,
  /\bgit\s+push\s+--force\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+branch\s+-[dD]\b/i,                     // never delete branches
  /\bgit\s+worktree\s+remove\b/i,                  // we manage worktrees server-side
];

function pathTouchesDisallowed(targetPath: string, cwd: string): string | null {
  const disallowed = getDisallowedPaths();
  const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
  const relFromCwd = path.relative(cwd, abs);
  // If the relative path escapes cwd entirely, treat as suspicious
  if (relFromCwd.startsWith('..')) return `path escapes the working directory: ${relFromCwd}`;
  for (const bad of disallowed) {
    const trimmed = bad.replace(/\/$/, '');
    if (relFromCwd === trimmed || relFromCwd.startsWith(trimmed + path.sep)) {
      return `disallowed path: ${trimmed}`;
    }
  }
  return null;
}

function bashIsAllowlisted(command: string, mode: AgentRunMode): boolean {
  const allowlist = mode === 'investigator' ? READONLY_BASH_PREFIXES : IMPLEMENTER_WRITE_BASH_ALLOWED;
  const trimmed = command.trim();
  // Split on `&&`, `;`, `|` and require every segment to be allowlisted.
  const segments = trimmed
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  return segments.every((seg) => allowlist.some((prefix) => seg.startsWith(prefix)));
}

export function buildCanUseTool(mode: AgentRunMode, opts: { cwd: string }): CanUseToolFn {
  const { cwd } = opts;

  return (toolName: string, input: ToolInput): PolicyDecision => {
    const deny = (message: string): PolicyDecision => {
      logger.warn('Agent tool call denied', { toolName, message });
      logEvent('AGENT_TOOL_DENIED', `${toolName}: ${message}`);
      return { behavior: 'deny', message };
    };
    const allow = (): PolicyDecision => ({ behavior: 'allow', updatedInput: input });

    // Investigator must never write — belt and suspenders.
    if (mode === 'investigator' && (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit')) {
      return deny(`Investigator mode cannot use ${toolName}. Report findings as JSON in your final message.`);
    }

    // Path guards for file-touching tools
    if (toolName === 'Edit' || toolName === 'Write' || toolName === 'Read' || toolName === 'NotebookEdit') {
      const targetPath = (input.file_path ?? input.path) as string | undefined;
      if (typeof targetPath === 'string' && targetPath.length > 0) {
        const blocked = pathTouchesDisallowed(targetPath, cwd);
        if (blocked) return deny(blocked);
      }
    }

    // Bash policy
    if (toolName === 'Bash') {
      const command = String(input.command ?? '');
      for (const pat of FORBIDDEN_BASH_PATTERNS) {
        if (pat.test(command)) return deny(`Bash command matches forbidden pattern (${pat.source})`);
      }
      // Additional path check for redirects targeting forbidden files.
      // `>>` must come first in the alternation so it's preferred over `>`.
      const redirectRe = /(?:>>|>)\s*([^\s|&;<>]+)/g;
      let redirectMatch: RegExpExecArray | null;
      while ((redirectMatch = redirectRe.exec(command)) !== null) {
        const target = redirectMatch[1];
        if (!target) continue;
        const blocked = pathTouchesDisallowed(target, cwd);
        if (blocked) return deny(`Bash redirect targets ${blocked}`);
      }
      if (!bashIsAllowlisted(command, mode)) {
        return deny(`Bash command not on the ${mode} allowlist: ${command.slice(0, 120)}`);
      }
      return allow();
    }

    // Web tools — disallowed unless explicitly enabled
    if (toolName === 'WebFetch' || toolName === 'WebSearch') {
      if (mode === 'implementer' && getAllowWeb()) return allow();
      return deny(`${toolName} is disabled (set AGENT_ALLOW_WEB=true to enable for implementer runs).`);
    }

    return allow();
  };
}
