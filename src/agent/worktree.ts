import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { getRepoRoot } from './repo_ops.js';
import { getBaseBranch } from './client.js';
import { logger } from '../utils/logger.js';

const execFileP = promisify(execFile);

/**
 * Git worktree management for implementer runs.
 *
 * We create a fresh worktree off `origin/<base>` for each implementer run.
 * The worktree lives under `<repo>/.claude/worktrees/agent-<shortId>` so
 * existing tooling (and `.gitignore` for `.claude/`) covers it.
 *
 * Worktrees are intentionally NOT auto-removed after the run completes —
 * the user reviews the branch locally. `cleanupAgentWorktree` exists for
 * manual cleanup via API if desired.
 *
 * Hard rules:
 *   - never use `--force` on remove or branch
 *   - never delete branches
 *   - never write outside `<repo>/.claude/worktrees/`
 */

export interface CreatedWorktree {
  path: string;
  branch: string;
  baseBranch: string;
  runId: string;
}

export async function createAgentWorktree(opts: { runId: string }): Promise<CreatedWorktree> {
  const repoRoot = getRepoRoot();
  const baseBranch = getBaseBranch();
  const shortId = opts.runId.slice(0, 8);
  const branch = `agent/${shortId}`;
  const wtRoot = path.join(repoRoot, '.claude', 'worktrees');
  const wtPath = path.join(wtRoot, `agent-${shortId}`);

  // Defensive: refuse to overwrite an existing path
  if (fs.existsSync(wtPath)) {
    throw new Error(`Worktree path already exists: ${wtPath}`);
  }
  fs.mkdirSync(wtRoot, { recursive: true });

  // Make sure we have an up-to-date base ref locally.
  try {
    await execFileP('git', ['fetch', 'origin', baseBranch], { cwd: repoRoot, timeout: 60_000 });
  } catch (err) {
    logger.warn('git fetch failed before worktree create — proceeding with local base ref', {
      base: baseBranch, err: String(err),
    });
  }

  const baseRef = `origin/${baseBranch}`;
  await execFileP('git', ['worktree', 'add', '-b', branch, wtPath, baseRef], {
    cwd: repoRoot, timeout: 60_000,
  });

  logger.info('Agent worktree created', { runId: opts.runId, path: wtPath, branch });
  return { path: wtPath, branch, baseBranch, runId: opts.runId };
}

export async function listAgentWorktrees(): Promise<Array<{ path: string; branch: string; runId: string | null }>> {
  const { stdout } = await execFileP('git', ['worktree', 'list', '--porcelain'], {
    cwd: getRepoRoot(),
  });
  const blocks = stdout.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  const results: Array<{ path: string; branch: string; runId: string | null }> = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const pathLine = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length) ?? '';
    const branchLine = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length) ?? '';
    const branchShort = branchLine.replace(/^refs\/heads\//, '');
    if (!branchShort.startsWith('agent/')) continue;
    const runIdMatch = path.basename(pathLine).match(/^agent-([0-9a-f]{8})$/);
    results.push({ path: pathLine, branch: branchShort, runId: runIdMatch?.[1] ?? null });
  }
  return results;
}

export async function cleanupAgentWorktree(wtPath: string): Promise<void> {
  if (!wtPath.includes(path.sep + '.claude' + path.sep + 'worktrees' + path.sep)) {
    throw new Error('Refusing to remove a path outside .claude/worktrees/');
  }
  await execFileP('git', ['worktree', 'remove', wtPath], { cwd: getRepoRoot(), timeout: 30_000 });
  logger.info('Agent worktree removed', { path: wtPath });
}
