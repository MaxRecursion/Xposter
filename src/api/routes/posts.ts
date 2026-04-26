import { Router, Request, Response } from 'express';
import {
  getRecentPosts, getPendingApproval, getDashboardStats,
  getActivityLog, getAllSettings, setSetting, updateFinalReply,
  getPost,
} from '../../storage/queries.js';
import { generateReply } from '../../pipeline/generator.js';
import { updateGeneratedReply, updatePostStatus } from '../../storage/queries.js';
import { sendApprovalNotification } from '../../notifications/ntfy.js';
import { logger } from '../../utils/logger.js';
import { requireApiKey } from '../auth.js';

export const postsRouter = Router();

function id(req: Request): string { return String(req.params['id']); }

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

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
  const post = getPost(id(req));
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
  const post = getPost(id(req));
  if (!post) return res.status(404).json({ error: 'not found' });

  updateFinalReply(id(req), reply.trim());
  res.json({ ok: true });
});

// Regenerate reply
postsRouter.post('/:id/regenerate', requireApiKey, async (req: Request, res: Response) => {
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
  const limit = clampInt(req.query['limit'], 100, 1, 500);
  res.json(getActivityLog(limit));
});

// Settings
postsRouter.get('/settings/all', (_req: Request, res: Response) => {
  res.json(getAllSettings());
});

postsRouter.patch('/settings/update', requireApiKey, (req: Request, res: Response) => {
  const updates = req.body as Record<string, string>;
  const normalized: Record<string, string> = {};

  if (updates['topic_keywords'] !== undefined) {
    normalized['topic_keywords'] = String(updates['topic_keywords']).slice(0, 500);
  }
  if (updates['min_score'] !== undefined) {
    normalized['min_score'] = String(clampInt(updates['min_score'], 40, 0, 100));
  }
  if (updates['max_candidates_per_run'] !== undefined) {
    normalized['max_candidates_per_run'] = String(clampInt(updates['max_candidates_per_run'], 3, 1, 10));
  }
  if (updates['approval_timeout_min'] !== undefined) {
    normalized['approval_timeout_min'] = String(clampInt(updates['approval_timeout_min'], 30, 5, 1440));
  }
  if (updates['system_running'] !== undefined) {
    normalized['system_running'] = String(updates['system_running'] === 'true');
  }

  for (const [k, v] of Object.entries(normalized)) {
    setSetting(k, v);
  }
  res.json({ ok: true });
});
