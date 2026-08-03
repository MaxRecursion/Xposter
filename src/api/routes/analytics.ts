import { Router, Request, Response } from 'express';
import { getAnalyticsOverview } from '../../storage/analytics.js';
import { getBaitTuningSnapshot } from '../../storage/engagement_performance.js';
import { clampInt } from '../http.js';
import { runWeeklyDigest } from '../../scheduler/weekly_digest.js';
import { requireApiKey } from '../auth.js';

export const analyticsRouter = Router();

analyticsRouter.get('/overview', (req: Request, res: Response) => {
  const days = clampInt(req.query['days'], 30, 7, 90);
  res.json(getAnalyticsOverview(days));
});

analyticsRouter.get('/bait-tuning', (req: Request, res: Response) => {
  const days = clampInt(req.query['days'], 14, 7, 90);
  res.json(getBaitTuningSnapshot(days));
});

analyticsRouter.post('/weekly-digest/send', requireApiKey, async (_req: Request, res: Response) => {
  const result = await runWeeklyDigest('manual');
  res.status(result.error ? 502 : 200).json(result);
});
