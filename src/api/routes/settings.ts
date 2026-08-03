import { Router, Request, Response } from 'express';
import { getAllSettings, setSetting } from '../../storage/queries.js';
import { requireApiKey } from '../auth.js';
import { buildWritableSettingNormalizers } from '../../storage/settings_schema.js';

export const settingsRouter = Router();

const SETTING_NORMALIZERS = buildWritableSettingNormalizers();

settingsRouter.get('/all', (_req: Request, res: Response) => {
  res.json(getAllSettings());
});

settingsRouter.patch('/update', requireApiKey, (req: Request, res: Response) => {
  const updates = req.body as Record<string, unknown>;

  for (const [key, normalize] of Object.entries(SETTING_NORMALIZERS)) {
    if (updates[key] !== undefined) {
      setSetting(key, normalize(updates[key]));
    }
  }
  res.json({ ok: true });
});
