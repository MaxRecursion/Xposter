import { Router, Request, Response } from 'express';
import { requireApiKey } from '../auth.js';
import {
  isAgentEnabled, isAgentInfraEnabled, isClaudeCliFound, isGhCliFound,
  getAgentModel, getMaxRunsPerDay,
} from '../../agent/client.js';
import { getRepoRoot, getRemoteUrl } from '../../agent/repo_ops.js';
import {
  listInvestigations, getInvestigation, setInvestigationStatus,
  listFeatureTasks, insertFeatureTask, getFeatureTask,
  listAgentRuns, getAgentRun, getRunCountToday,
  getActivityRowsSince,
} from '../../agent/store.js';
import { runInvestigation } from '../../agent/investigator.js';
import { runImplementer } from '../../agent/implementer.js';
import { runAgentWatcherTick } from '../../agent/watcher.js';
import { getOrCreateChannel } from '../../agent/sse.js';
import { getSetting } from '../../storage/queries.js';
import { logger } from '../../utils/logger.js';

export const agentRouter = Router();

// ── Read-only endpoints (no api key required for status/list) ─────────────────

agentRouter.get('/status', (_req: Request, res: Response) => {
  res.json({
    enabled: isAgentEnabled(),
    infraDisabled: !isAgentInfraEnabled(),
    settingEnabled: getSetting('agent_enabled', 'false') === 'true',
    claudeCliFound: isClaudeCliFound(),
    ghFound: isGhCliFound(),
    model: getAgentModel(),
    maxRunsPerDay: getMaxRunsPerDay(),
    runsToday: getRunCountToday(),
    lastWatchTickAt: parseInt(getSetting('agent_last_watched_at', '0'), 10),
    errorThreshold: parseInt(getSetting('agent_error_threshold', '3'), 10),
    repoRoot: getRepoRoot(),
    remoteUrl: getRemoteUrl(),
  });
});

agentRouter.get('/investigations', (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  res.json(listInvestigations({ status: status as never, limit: 100 }));
});

agentRouter.get('/investigations/:id', (req: Request, res: Response) => {
  const inv = getInvestigation(String(req.params['id']));
  if (!inv) return res.status(404).json({ error: 'not_found' });
  const run = inv.run_id ? getAgentRun(inv.run_id) : null;
  res.json({ investigation: inv, run });
});

agentRouter.get('/features', (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  res.json(listFeatureTasks({ status: status as never, limit: 100 }));
});

agentRouter.get('/runs', (req: Request, res: Response) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 500);
  res.json(listAgentRuns(limit));
});

agentRouter.get('/runs/:id', (req: Request, res: Response) => {
  const run = getAgentRun(String(req.params['id']));
  if (!run) return res.status(404).json({ error: 'not_found' });
  res.json(run);
});

// ── SSE: live run progress ────────────────────────────────────────────────────
// EventSource can't send custom headers — we accept ?key=<api_key> instead.
// requireApiKey already supports the `key` query param.
agentRouter.get('/runs/:id/stream', requireApiKey, (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const channel = getOrCreateChannel(String(req.params['id']));
  const send = (data: string) => {
    res.write(`data: ${data}\n\n`);
  };

  // Initial replay happens inside subscribe (it loops the buffer first).
  const unsubscribe = channel.subscribe((msg) => {
    try { send(JSON.stringify(msg)); } catch { /* ignore */ }
  });

  // Heartbeat every 15s so proxies don't close idle connections.
  const heartbeat = setInterval(() => { res.write(':heartbeat\n\n'); }, 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// ── Mutating endpoints ────────────────────────────────────────────────────────

function require503IfDisabled(res: Response): boolean {
  if (!isAgentEnabled()) {
    res.status(503).json({
      error: 'agent_disabled',
      hint: 'Toggle the agent on under Settings → Agent in the dashboard.',
    });
    return true;
  }
  if (!isClaudeCliFound()) {
    res.status(503).json({
      error: 'claude_cli_missing',
      hint: 'Install Claude Code from https://claude.com/code',
    });
    return true;
  }
  return false;
}

agentRouter.post('/watch/tick', requireApiKey, async (_req: Request, res: Response) => {
  if (require503IfDisabled(res)) return;
  try {
    const result = await runAgentWatcherTick('manual');
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

agentRouter.post('/investigate', requireApiKey, async (req: Request, res: Response) => {
  if (require503IfDisabled(res)) return;
  const activityIds = Array.isArray(req.body?.activityIds) ? req.body.activityIds : [];
  if (activityIds.length === 0) {
    return res.status(400).json({ error: 'activityIds required' });
  }
  // Fetch the rows
  const since = 0;
  const all = getActivityRowsSince(since, [
    'PIPELINE_ERROR', 'CANDIDATE_ERROR', 'POST_ERROR', 'NOTIFICATION_FAILED',
    'FOLLOWER_SYNC_ERROR', 'DELETE_ERROR', 'AUDIENCE_SYNC_FAILED',
    'AUDIENCE_SYNC_ERROR', 'ORIGINAL_POST_ERROR',
  ]);
  const set = new Set<number>(activityIds.map((n: unknown) => Number(n)).filter(Number.isFinite));
  const errors = all.filter((r) => set.has(r.id));
  if (errors.length === 0) return res.status(404).json({ error: 'no matching activity rows' });

  // Fire async — return runId so the client can stream
  try {
    res.status(202);
    const promise = runInvestigation({ errors, trigger: 'manual' });
    // Wait briefly so we can return the runId synchronously
    const result = await Promise.race([
      promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    if (result) {
      res.json({ ok: true, runId: result.runId, investigationId: result.investigation.id });
    } else {
      // Still running — kick off in background, respond with a placeholder
      promise.catch((err) => logger.error('investigation background error', { err: String(err) }));
      res.json({ ok: true, status: 'running' });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

agentRouter.post('/investigations/:id/apply', requireApiKey, async (req: Request, res: Response) => {
  if (require503IfDisabled(res)) return;
  const inv = getInvestigation(String(req.params['id']));
  if (!inv) return res.status(404).json({ error: 'not_found' });
  if (inv.status !== 'PROPOSED') {
    return res.status(409).json({ error: 'invalid_status', current: inv.status });
  }
  try {
    // Fire and detach — long-running
    res.status(202).json({ ok: true, status: 'running' });
    void runImplementer({ source: { kind: 'investigation', id: inv.id }, trigger: 'manual' })
      .catch((err) => logger.error('implementer (investigation) failed', { err: String(err) }));
  } catch (err) {
    // Should be unreachable — runImplementer is async
    res.status(500).json({ ok: false, error: String(err) });
  }
});

agentRouter.post('/investigations/:id/dismiss', requireApiKey, (req: Request, res: Response) => {
  const inv = getInvestigation(String(req.params['id']));
  if (!inv) return res.status(404).json({ error: 'not_found' });
  setInvestigationStatus(inv.id, 'DISMISSED');
  res.json({ ok: true });
});

agentRouter.post('/features', requireApiKey, async (req: Request, res: Response) => {
  if (require503IfDisabled(res)) return;
  const title = String(req.body?.title ?? '').trim().slice(0, 200);
  const description = String(req.body?.description ?? '').trim().slice(0, 5000);
  if (!title || !description) {
    return res.status(400).json({ error: 'title and description required' });
  }
  const task = insertFeatureTask({ title, description });
  res.status(202).json({ ok: true, taskId: task.id });
  void runImplementer({ source: { kind: 'feature', id: task.id }, trigger: 'manual' })
    .catch((err) => logger.error('implementer (feature) failed', { taskId: task.id, err: String(err) }));
});

agentRouter.get('/features/:id', (req: Request, res: Response) => {
  const task = getFeatureTask(String(req.params['id']));
  if (!task) return res.status(404).json({ error: 'not_found' });
  const run = task.run_id ? getAgentRun(task.run_id) : null;
  res.json({ task, run });
});
