import { Router, Request, Response } from 'express';
import {
  countActionedFollowBacksToday, getFollowerEvent, listFollowerEvents,
  setFollowerEventStatus, setFollowingState,
} from '../../storage/accounts.js';
import { getSetting, logEvent } from '../../storage/queries.js';
import { followBack } from '../../browser/followers.js';
import { runFollowerSync } from '../../scheduler/follower_sync.js';
import { logger } from '../../utils/logger.js';
import { requireApiKey, callerLabel } from '../auth.js';

export const followRouter = Router();

function id(req: Request): number {
  return parseInt(String(req.params['id']), 10);
}

function wantsHtml(req: Request): boolean {
  if (req.method !== 'GET') return false;
  const accept = String(req.headers['accept'] ?? '');
  if (accept.includes('application/json') && !accept.includes('text/html')) return false;
  return true;
}

function htmlOk(req: Request, res: Response, title: string, msg: string): void {
  if (wantsHtml(req)) {
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
      <style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,sans-serif;background:#101820;color:#f6f1e7;}main{max-width:520px;text-align:center;padding:28px;}h1{margin:0 0 10px;font-size:26px;}p{font-size:16px;color:#dccfb8;}a{color:#ffd166;font-weight:700;}</style>
      </head><body><main><h1>${title}</h1><p>${msg}</p><p><a href="/">Back to dashboard</a></p></main></body></html>`);
    return;
  }
  res.json({ ok: true, message: msg });
}

function htmlErr(req: Request, res: Response, status: number, title: string, msg: string): void {
  if (wantsHtml(req)) {
    res.status(status).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
      <style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,sans-serif;background:#101820;color:#f6f1e7;}main{max-width:520px;text-align:center;padding:28px;}h1{margin:0 0 10px;font-size:26px;color:#ff6b6b;}p{font-size:16px;color:#dccfb8;}</style>
      </head><body><main><h1>${title}</h1><p>${msg}</p></main></body></html>`);
    return;
  }
  res.status(status).json({ error: msg });
}

// GET pending follower events
followRouter.get('/pending', (_req: Request, res: Response) => {
  res.json(listFollowerEvents('PENDING'));
});

followRouter.get('/all', (_req: Request, res: Response) => {
  res.json(listFollowerEvents());
});

// Manually trigger a follower sync
followRouter.post('/sync', requireApiKey, async (_req: Request, res: Response) => {
  res.json({ ok: true, message: 'Follower sync triggered' });
  try {
    await runFollowerSync();
  } catch (err) {
    logger.error('Manual follower sync failed', { err });
  }
});

// Approve/follow-back: GET allowed for ntfy view actions
async function handleFollowApprove(req: Request, res: Response): Promise<void> {
  const eventId = id(req);
  const event = getFollowerEvent(eventId);
  if (!event) { htmlErr(req, res, 404, 'Not found', 'Follower event no longer exists.'); return; }
  if (event.status !== 'PENDING') {
    htmlErr(req, res, 409, 'Already handled', `Status: ${event.status}`);
    return;
  }

  // Daily cap
  const cap = parseInt(getSetting('max_follow_backs_per_day', '15'), 10) || 15;
  const used = countActionedFollowBacksToday();
  if (used >= cap) {
    htmlErr(req, res, 429, 'Daily limit reached', `Already followed back ${used} accounts today (cap ${cap}).`);
    return;
  }

  setFollowerEventStatus(eventId, 'APPROVED');
  logEvent('FOLLOW_BACK_APPROVED', `@${event.account_handle} via ${callerLabel(req)}`);

  htmlOk(req, res, 'Following back', `Following @${event.account_handle} in the background.`);

  try {
    const ok = await followBack(event.account_handle);
    if (ok) {
      setFollowingState(event.account_handle, true);
      setFollowerEventStatus(eventId, 'ACTIONED');
      logEvent('FOLLOW_BACK_ACTIONED', `@${event.account_handle}`);
    } else {
      setFollowerEventStatus(eventId, 'ERROR', 'follow button not found / click failed');
      logEvent('FOLLOW_BACK_ERROR', `@${event.account_handle}: button not clickable`);
    }
  } catch (err) {
    setFollowerEventStatus(eventId, 'ERROR', String(err).slice(0, 200));
    logEvent('FOLLOW_BACK_ERROR', `@${event.account_handle}: ${String(err)}`);
  }
}

followRouter.post('/approve/:id', requireApiKey, handleFollowApprove);
followRouter.get('/approve/:id', requireApiKey, handleFollowApprove);

function handleFollowSkip(req: Request, res: Response): void {
  const eventId = id(req);
  const event = getFollowerEvent(eventId);
  if (!event) { htmlErr(req, res, 404, 'Not found', 'Follower event no longer exists.'); return; }

  setFollowerEventStatus(eventId, 'SKIPPED');
  logEvent('FOLLOW_BACK_SKIPPED', `@${event.account_handle} via ${callerLabel(req)}`);
  htmlOk(req, res, 'Skipped', `@${event.account_handle} skipped.`);
}

followRouter.post('/skip/:id', requireApiKey, handleFollowSkip);
followRouter.get('/skip/:id', requireApiKey, handleFollowSkip);
