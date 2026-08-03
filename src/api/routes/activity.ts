import { Router, Request, Response } from 'express';
import { getActivityLog } from '../../storage/queries.js';
import { clampInt } from '../../utils/number.js';

export const activityRouter = Router();

activityRouter.get('/', (req: Request, res: Response) => {
  const limit = clampInt(req.query['limit'], 100, 1, 500);
  res.json(getActivityLog(limit));
});
