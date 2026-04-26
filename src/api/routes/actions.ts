import { Router, Request, Response } from 'express';
import {
  getPost, updatePostStatus, logEvent, getSetting, setSetting,
} from '../../storage/queries.js';
import { postReply } from '../../browser/posting.js';
import { logger } from '../../utils/logger.js';
import { getDb } from '../../storage/db.js';
import { callerLabel, requireActionAuth, requireApiKey } from '../auth.js';

export const actionsRouter = Router();

function id(req: Request): string { return String(req.params['id']); }

function wantsHtml(req: Request): boolean {
  return req.method === 'GET' || req.accepts(['html', 'json']) === 'html';
}

function sendActionResponse(
  req: Request,
  res: Response,
  status: number,
  title: string,
  message: string,
): void {
  if (!wantsHtml(req)) {
    res.status(status).json(status >= 400 ? { error: message } : { ok: true, message });
    return;
  }

  const homeUrl = '/';
  res.status(status).type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #101820; color: #f6f1e7; }
      main { max-width: 520px; padding: 28px; text-align: center; }
      h1 { margin: 0 0 10px; font-size: 28px; }
      p { font-size: 17px; line-height: 1.45; color: #dccfb8; }
      a { color: #ffd166; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <p><a href="${homeUrl}">Open Xposter dashboard</a></p>
    </main>
  </body>
</html>`);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function handleApprove(req: Request, res: Response): Promise<void> {
  const post = getPost(id(req));
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
  const minInterval = parseInt(
    process.env.MIN_REPLY_INTERVAL_SECONDS ?? getSetting('min_reply_interval_sec', '300'),
    10,
  );

  const lastPosted = getLastPostedTimestamp();
  const secondsSinceLast = Date.now() / 1000 - lastPosted;
  if (secondsSinceLast < minInterval) {
    const waitSec = Math.ceil(minInterval - secondsSinceLast);
    sendActionResponse(req, res, 429, 'Rate limited', `Wait ${waitSec}s before posting again.`);
    return;
  }

  updatePostStatus(post.id, 'POSTING');
  logEvent('APPROVE', `approved via ${callerLabel(req)}`, post.id);

  // Respond immediately; post asynchronously
  sendActionResponse(req, res, 202, 'Approved', 'Posting is in progress. You can close this tab.');

  try {
    await postReply(post.tweet_url, replyText);
    updatePostStatus(post.id, 'POSTED');
    logEvent('POSTED', replyText, post.id);
    logger.info('Reply posted', { postId: post.id });
  } catch (err) {
    updatePostStatus(post.id, 'ERROR');
    logEvent('POST_ERROR', String(err), post.id);
    logger.error('Posting failed', { postId: post.id, err });
  }
}

// POST /api/actions/approve/:id
actionsRouter.post('/approve/:id', requireActionAuth('approve'), handleApprove);

// GET /api/actions/approve/:id
// Used by ntfy iOS view actions, which are more reliable than background HTTP actions on local LAN URLs.
actionsRouter.get('/approve/:id', requireActionAuth('approve'), handleApprove);

// POST /api/actions/skip/:id
function handleSkip(req: Request, res: Response): void {
  const post = getPost(id(req));
  if (!post) {
    sendActionResponse(req, res, 404, 'Post not found', 'This candidate no longer exists.');
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

function getLastPostedTimestamp(): number {
  const row = getDb()
    .prepare(`SELECT updated_at FROM posts WHERE status = 'POSTED' ORDER BY updated_at DESC LIMIT 1`)
    .get() as { updated_at: number } | undefined;
  return row?.updated_at ?? 0;
}
