import { Router, Request, Response } from 'express';
import {
  countActionedFollowBacksToday, getFollowerEvent, listFollowerEvents,
  listPendingFollowBackEvents, setFollowerEventStatus,
} from '../../storage/follower_events.js';
import { setFollowingState } from '../../storage/accounts.js';
import { claimFollowerEventForApproval } from '../../storage/follower_events.js';
import { logEvent } from '../../storage/queries.js';
import { getIntSetting } from '../../storage/settings.js';
import { followBack } from '../../browser/followers.js';
import { runFollowerSync } from '../../scheduler/follower_sync.js';
import { logger } from '../../utils/logger.js';
import { requireApiKey, callerLabel } from '../auth.js';
import { sendActionResponse } from '../http.js';

export const followRouter = Router();

function id(req: Request): number {
  return parseInt(String(req.params['id']), 10);
}

// Shared HTML/JSON responder (escapes interpolated content, unlike the old
// hand-rolled templates this file used to carry).
function htmlOk(req: Request, res: Response, title: string, msg: string): void {
  sendActionResponse(req, res, 200, title, msg);
}

function htmlErr(req: Request, res: Response, status: number, title: string, msg: string): void {
  sendActionResponse(req, res, status, title, msg);
}

// GET pending follower events
followRouter.get('/pending', (_req: Request, res: Response) => {
  res.json(listPendingFollowBackEvents());
});

followRouter.get('/all', (_req: Request, res: Response) => {
  res.json(listFollowerEvents());
});

// Manually trigger a follower sync
followRouter.post('/sync', requireApiKey, async (_req: Request, res: Response) => {
  try {
    const result = await runFollowerSync();
    if (!result.ok) {
      const status = result.reason === 'system_paused' ? 409 : 400;
      res.status(status).json({ error: result.message ?? 'Follower sync failed', ...result });
      return;
    }
    res.json({
      ...result,
      ok: true,
      message: `Follower sync complete: ${result.total} followers scanned, ${result.notFollowedBack ?? 0} not followed back, ${result.queued} pending.`,
    });
  } catch (err) {
    logger.error('Manual follower sync failed', { err });
    res.status(500).json({ error: String(err) });
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

  // Daily cap (0 is a valid value and disables follow-backs entirely)
  const cap = getIntSetting('max_follow_backs_per_day', 15, 0, 100);
  const used = countActionedFollowBacksToday();
  if (used >= cap) {
    htmlErr(req, res, 429, 'Daily limit reached', `Already followed back ${used} accounts today (cap ${cap}).`);
    return;
  }

  // Atomic claim — a concurrent double tap loses the race instead of
  // triggering a second follow action in the browser.
  if (!claimFollowerEventForApproval(eventId)) {
    htmlErr(req, res, 409, 'Already handled', 'This event was just handled by another request.');
    return;
  }
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

  // A stale Skip tap must not clobber an event that was already actioned.
  if (event.status !== 'PENDING') {
    htmlErr(req, res, 409, 'Already handled', `Status: ${event.status}`);
    return;
  }

  setFollowerEventStatus(eventId, 'SKIPPED');
  logEvent('FOLLOW_BACK_SKIPPED', `@${event.account_handle} via ${callerLabel(req)}`);
  htmlOk(req, res, 'Skipped', `@${event.account_handle} skipped.`);
}

followRouter.post('/skip/:id', requireApiKey, handleFollowSkip);
followRouter.get('/skip/:id', requireApiKey, handleFollowSkip);
