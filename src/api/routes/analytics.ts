import { Router, Request, Response } from 'express';
import { getAnalyticsOverview } from '../../storage/analytics.js';
import { clampInt } from '../http.js';

export const analyticsRouter = Router();

analyticsRouter.get('/overview', (req: Request, res: Response) => {
  const days = clampInt(req.query['days'], 30, 7, 90);
  res.json(getAnalyticsOverview(days));
});
