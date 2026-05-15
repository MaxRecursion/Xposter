import { Router, Request, Response } from 'express';
import { getLatestHeatmap } from '../../storage/audience.js';
import { runAudienceSync } from '../../scheduler/audience_sync.js';
import { requireApiKey } from '../auth.js';

export const audienceRouter = Router();

/** Latest 7×24 heatmap + freshness metadata. Null fields when no snapshot exists yet. */
audienceRouter.get('/heatmap', (_req: Request, res: Response) => {
  const latest = getLatestHeatmap();
  if (!latest) {
    res.json({ heatmap: null, levels: null, fetched_at: null, age_seconds: null });
    return;
  }
  let heatmap: number[][] | null = null;
  let levels: number[][] | null = null;
  try { heatmap = JSON.parse(latest.cells_json); } catch { /* ignored */ }
  if (latest.raw_levels) {
    try { levels = JSON.parse(latest.raw_levels); } catch { /* ignored */ }
  }
  res.json({
    heatmap,
    levels,
    fetched_at: latest.fetched_at,
    age_seconds: Math.floor(Date.now() / 1000) - latest.fetched_at,
  });
});

/** Manually trigger a scrape. Auth-gated to avoid unauth'd traffic to x.com. */
audienceRouter.post('/refresh', requireApiKey, async (_req: Request, res: Response) => {
  const result = await runAudienceSync('manual');
  res.status(result.ok ? 200 : 500).json(result);
});
