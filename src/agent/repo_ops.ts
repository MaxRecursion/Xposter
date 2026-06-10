import { execFileSync } from 'child_process';
import path from 'path';
import { isClaudeCliFound, isGhCliFound } from './client.js';

/**
 * Read-only repo metadata helpers used by the agent module.
 *
 * Cached at module load to avoid repeated `git` invocations on every API call.
 */

let _repoRoot: string | null = null;

export function getRepoRoot(): string {
  if (_repoRoot) return _repoRoot;
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    _repoRoot = out.toString().trim();
    if (!_repoRoot) throw new Error('empty git rev-parse output');
    return _repoRoot;
  } catch (err) {
    // Fall back to cwd — better than crashing the whole server
    _repoRoot = path.resolve(process.cwd());
    return _repoRoot;
  }
}

let _remoteUrl: string | null | undefined;

export function getRemoteUrl(): string | null {
  if (_remoteUrl !== undefined) return _remoteUrl;
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: getRepoRoot(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    _remoteUrl = out.toString().trim() || null;
  } catch {
    _remoteUrl = null;
  }
  return _remoteUrl;
}

export interface AgentReadiness {
  claudeCliFound: boolean;
  ghFound: boolean;
  repoRoot: string;
  remoteUrl: string | null;
}

export function getReadiness(): AgentReadiness {
  return {
    claudeCliFound: isClaudeCliFound(),
    ghFound: isGhCliFound(),
    repoRoot: getRepoRoot(),
    remoteUrl: getRemoteUrl(),
  };
}
