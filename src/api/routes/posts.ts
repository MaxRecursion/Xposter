import { Router, Request, Response } from 'express';
import {
  getRecentPosts, getPendingApproval, getDashboardStats,
  updateFinalReply, getPost,
} from '../../storage/queries.js';
import { generateReply } from '../../pipeline/generator.js';
import { updateGeneratedReply, updatePostStatus } from '../../storage/queries.js';
import { sendApprovalNotification } from '../../notifications/ntfy.js';
import { logger } from '../../utils/logger.js';
import { requireApiKey } from '../auth.js';
import { paramString } from '../http.js';
import { clampInt } from '../../utils/number.js';

export const postsRouter = Router();

// Dashboard stats
postsRouter.get('/stats', (_req: Request, res: Response) => {
  res.json(getDashboardStats());
});

// Recent posts (last 24h)
postsRouter.get('/', (req: Request, res: Response) => {
  const hours = clampInt(req.query['hours'], 24, 1, 168);
  res.json(getRecentPosts(hours));
});

// Pending approval queue
postsRouter.get('/pending', (_req: Request, res: Response) => {
  res.json(getPendingApproval());
});

// Single post
postsRouter.get('/:id', (req: Request, res: Response) => {
  const post = getPost(paramString(req, 'id'));
  if (!post) return res.status(404).json({ error: 'not found' });
  res.json(post);
});

// Edit the final reply text before approving
postsRouter.patch('/:id/reply', requireApiKey, (req: Request, res: Response) => {
  const { reply } = req.body as { reply?: string };
  if (!reply || typeof reply !== 'string' || reply.trim().length === 0) {
    return res.status(400).json({ error: 'reply text required' });
  }
  if (reply.length > 280) {
    return res.status(400).json({ error: 'reply must be 280 characters or less' });
  }
  const post = getPost(paramString(req, 'id'));
  if (!post) return res.status(404).json({ error: 'not found' });

  updateFinalReply(post.id, reply.trim());
  res.json({ ok: true });
});

// Regenerate reply
postsRouter.post('/:id/regenerate', requireApiKey, async (req: Request, res: Response) => {
  const post = getPost(paramString(req, 'id'));
  if (!post) return res.status(404).json({ error: 'not found' });

  try {
    updatePostStatus(post.id, 'GENERATING');
    const reply = await generateReply(post);
    updateGeneratedReply(post.id, reply);

    // Resend notification
    const updated = getPost(post.id)!;
    await sendApprovalNotification(updated);

    res.json({ ok: true, reply });
  } catch (err) {
    logger.error('Regenerate failed', { id: post.id, err });
    updatePostStatus(post.id, 'ERROR');
    res.status(500).json({ error: String(err) });
  }
});
