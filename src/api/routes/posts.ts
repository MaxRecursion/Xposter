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
import { clampInt, paramString } from '../http.js';

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

// Activity log
postsRouter.get('/log/activity', (req: Request, res: Response) => {
  const limit = clampInt(req.query['limit'], 100, 1, 500);
  res.json(getActivityLog(limit));
});

// Settings
postsRouter.get('/settings/all', (_req: Request, res: Response) => {
  res.json(getAllSettings());
});

// Allowlist of writable settings and how each value is normalized. Anything
// not listed here is silently ignored.
const intSetting = (fallback: number, min: number, max: number) =>
  (v: unknown) => String(clampInt(v, fallback, min, max));
const boolSetting = (v: unknown) => String(v === 'true');
const textSetting = (maxLen: number) => (v: unknown) => String(v).slice(0, maxLen);

const SETTING_NORMALIZERS: Record<string, (v: unknown) => string> = {
  topic_keywords:              textSetting(500),
  min_score:                   intSetting(40, 0, 100),
  max_candidates_per_run:      intSetting(5, 1, 20),
  require_approval:            boolSetting,
  approval_timeout_min:        intSetting(30, 5, 1440),
  system_running:              boolSetting,
  wit_level:                   intSetting(55, 0, 100),
  random_runs_per_day:         intSetting(20, 1, 30),
  active_window_start_hour:    intSetting(9, 0, 23),
  active_window_end_hour:      intSetting(22, 1, 24),
  max_follow_backs_per_day:    intSetting(15, 0, 100),
  classification_ttl_days:     intSetting(7, 1, 90),
  blocklist_classifications:   textSetting(200),
  original_posts_per_day:      intSetting(10, 1, 15),
  original_post_marathi_ratio: intSetting(40, 0, 100),
  agent_enabled:               boolSetting,
  agent_error_threshold:       intSetting(3, 1, 50),
  agentic_generation:          boolSetting,
  auto_follow_back_enabled:    boolSetting,
  auto_follow_back_classifications: textSetting(200),
  auto_follow_back_min_confidence:  intSetting(60, 0, 100),
  weekly_digest_enabled:            boolSetting,
  weekly_digest_hour:               intSetting(9, 0, 23),
  likes_enabled:                    boolSetting,
  likes_per_day:                    intSetting(100, 0, 500),
  topic_daily_cap:                  intSetting(10, 1, 100), // percentage of planned daily volume
  image_posts_enabled:              boolSetting,
  image_posts_per_day:              intSetting(1, 0, 3),
  image_evening_start_hour:         intSetting(18, 0, 23),
  image_evening_end_hour:           intSetting(22, 1, 24),
};

postsRouter.patch('/settings/update', requireApiKey, (req: Request, res: Response) => {
  const updates = req.body as Record<string, unknown>;

  for (const [key, normalize] of Object.entries(SETTING_NORMALIZERS)) {
    if (updates[key] !== undefined) {
      setSetting(key, normalize(updates[key]));
    }
  }
  res.json({ ok: true });
});
