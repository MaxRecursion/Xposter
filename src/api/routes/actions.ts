import { Router, Request, Response } from 'express';
import {
  getPost, logEvent, getSetting, setSetting, updatePostStatus,
  getLastPostedUnix, claimPostForPosting,
} from '../../storage/queries.js';
import { getMinReplyIntervalSeconds } from '../../config.js';
import { getIntSetting } from '../../storage/settings.js';
import { logger } from '../../utils/logger.js';
import { callerLabel, requireActionAuth, requireApiKey } from '../auth.js';
import { paramString, sendActionResponse } from '../http.js';
import { publishReply } from '../../pipeline/reply_publisher.js';

export const actionsRouter = Router();

async function handleApprove(req: Request, res: Response): Promise<void> {
  const post = getPost(paramString(req, 'id'));
  if (!post) {
    sendActionResponse(req, res, 404, 'Post not found', 'This candidate no longer exists.');
    return;
  }

  if (post.status !== 'PENDING_APPROVAL') {
    sendActionResponse(req, res, 409, 'Already handled', `This post is in status ${post.status}.`);
    return;
  }

  const replyText = post.final_reply ?? post.generated_reply;
  if (!replyText) {
    sendActionResponse(req, res, 400, 'No reply text', 'There is no generated reply to post.');
    return;
  }

  // Enforce minimum reply interval
  const minInterval = getMinReplyIntervalSeconds();

  const lastPosted = getLastPostedUnix();
  const secondsSinceLast = Date.now() / 1000 - lastPosted;
  if (secondsSinceLast < minInterval) {
    const waitSec = Math.ceil(minInterval - secondsSinceLast);
    sendActionResponse(req, res, 429, 'Rate limited', `Wait ${waitSec}s before posting again.`);
    return;
  }

  // Atomic claim: a second concurrent approve (double tap) loses the race here
  // instead of triggering a duplicate browser posting flow.
  if (!claimPostForPosting(post.id)) {
    sendActionResponse(req, res, 409, 'Already handled', 'This post was just handled by another request.');
    return;
  }
  logEvent('APPROVE', `approved via ${callerLabel(req)}`, post.id);

  // Respond immediately; post asynchronously
  sendActionResponse(req, res, 202, 'Approved', 'Posting is in progress. You can close this tab.');

  const outcome = await publishReply(post, replyText, null);
  logger.info('Approved reply posting finished', { postId: post.id, outcome });
}

// POST /api/actions/approve/:id
actionsRouter.post('/approve/:id', requireActionAuth('approve'), handleApprove);

// GET /api/actions/approve/:id
// Used by ntfy iOS view actions, which are more reliable than background HTTP actions on local LAN URLs.
actionsRouter.get('/approve/:id', requireActionAuth('approve'), handleApprove);

// POST /api/actions/skip/:id
function handleSkip(req: Request, res: Response): void {
  const post = getPost(paramString(req, 'id'));
  if (!post) {
    sendActionResponse(req, res, 404, 'Post not found', 'This candidate no longer exists.');
    return;
  }

  // A stale Skip tap must never clobber a reply that already went out.
  if (post.status === 'POSTED' || post.status === 'POSTING' || post.status === 'DELETED') {
    sendActionResponse(req, res, 409, 'Already handled', `This post is in status ${post.status}.`);
    return;
  }

  updatePostStatus(post.id, 'SKIPPED');
  logEvent('SKIP', `skipped via ${callerLabel(req)}`, post.id);
  logger.info('Post skipped', { postId: post.id });

  sendActionResponse(req, res, 200, 'Skipped', 'Candidate skipped. You can close this tab.');
}

actionsRouter.post('/skip/:id', requireActionAuth('skip'), handleSkip);

// GET /api/actions/skip/:id
// Used by ntfy iOS view actions, which are more reliable than background HTTP actions on local LAN URLs.
actionsRouter.get('/skip/:id', requireActionAuth('skip'), handleSkip);

// GET /api/actions/status — system health check
actionsRouter.get('/status', (_req: Request, res: Response) => {
  const running = getSetting('system_running', 'true') === 'true';
  res.json({ system_running: running, timestamp: Date.now() });
});

// POST /api/actions/toggle - start/stop system
actionsRouter.post('/toggle', requireApiKey, (_req: Request, res: Response) => {
  const current = getSetting('system_running', 'true') === 'true';
  setSetting('system_running', String(!current));
  res.json({ system_running: !current });
});
