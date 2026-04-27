import { Router, Request, Response } from 'express';
import {
  listOriginalPostsWithImpressions, getTopicPerformance,
} from '../../storage/original_posts.js';
import {
  triggerOriginalPost, ensureTodayOriginalPlan, getNextOriginalRuns,
  runImpressionSync,
} from '../../scheduler/original_posts.js';
import { requireApiKey } from '../auth.js';

export const originalPostsRouter = Router();

// List recent original posts with their latest impression data
originalPostsRouter.get('/', (_req: Request, res: Response) => {
  res.json(listOriginalPostsWithImpressions(100));
});

// Per-topic engagement performance (for the dashboard chart)
originalPostsRouter.get('/topic-performance', (_req: Request, res: Response) => {
  res.json(getTopicPerformance());
});

// Today's schedule
originalPostsRouter.get('/schedule/today', (_req: Request, res: Response) => {
  res.json(ensureTodayOriginalPlan());
});

originalPostsRouter.get('/schedule/upcoming', (_req: Request, res: Response) => {
  res.json(getNextOriginalRuns(10));
});

// Manually trigger one original post right now
originalPostsRouter.post('/trigger', requireApiKey, async (_req: Request, res: Response) => {
  const result = await triggerOriginalPost();
  res.status(result.ok ? 200 : 409).json(result);
});

// Manually trigger impression sync
originalPostsRouter.post('/sync-impressions', requireApiKey, async (_req: Request, res: Response) => {
  const result = await runImpressionSync();
  res.json({ ok: true, ...result });
});
