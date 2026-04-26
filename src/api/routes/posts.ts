import { Router, Request, Response, RequestHandler } from 'express';

function id(req: Request): string { return String(req.params['id']); }
import {
  getRecentPosts, getPendingApproval, getDashboardStats,
  getActivityLog, getAllSettings, setSetting, updateFinalReply,
  getPost,
} from '../../storage/queries.js';
import { generateReply } from '../../pipeline/generator.js';
import { updateGeneratedReply, updatePostStatus } from '../../storage/queries.js';
import { sendApprovalNotification } from '../../notifications/ntfy.js';
import { logger } from '../../utils/logger.js';

export const postsRouter = Router();

// Dashboard stats
postsRouter.get('/stats', (_req: Request, res: Response) => {
  res.json(getDashboardStats());
});

// Recent posts (last 24h)
postsRouter.get('/', (req: Request, res: Response) => {
  const hours = parseInt(String(req.query['hours'] ?? '24'), 10);
  res.json(getRecentPosts(hours));
});

// Pending approval queue
postsRouter.get('/pending', (_req: Request, res: Response) => {
  res.json(getPendingApproval());
});

// Single post
postsRouter.get('/:id', (req: Request, res: Response) => {
  const post = getPost(id(req));
  if (!post) return res.status(404).json({ error: 'not found' });
  res.json(post);
});

// Edit the final reply text before approving
postsRouter.patch('/:id/reply', (req: Request, res: Response) => {
  const { reply } = req.body as { reply?: string };
  if (!reply || typeof reply !== 'string' || reply.trim().length === 0) {
    return res.status(400).json({ error: 'reply text required' });
  }
  const post = getPost(id(req));
  if (!post) return res.status(404).json({ error: 'not found' });

  updateFinalReply(id(req), reply.trim());
  res.json({ ok: true });
});

// Regenerate reply
postsRouter.post('/:id/regenerate', async (req: Request, res: Response) => {
  const post = getPost(id(req));
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

// Activity log
postsRouter.get('/log/activity', (req: Request, res: Response) => {
  const limit = parseInt(String(req.query['limit'] ?? '100'), 10);
  res.json(getActivityLog(limit));
});

// Settings
postsRouter.get('/settings/all', (_req: Request, res: Response) => {
  res.json(getAllSettings());
});

postsRouter.patch('/settings/update', (req: Request, res: Response) => {
  const updates = req.body as Record<string, string>;
  const allowed = [
    'topic_keywords', 'min_score', 'max_candidates_per_run',
    'approval_timeout_min', 'system_running',
  ];
  for (const [k, v] of Object.entries(updates)) {
    if (allowed.includes(k)) setSetting(k, String(v));
  }
  res.json({ ok: true });
});
