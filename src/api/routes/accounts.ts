import { Router, Request, Response } from 'express';
import {
  Classification, getAccount, getInteractionStats, listAccounts,
  listRecentInteractions,
} from '../../storage/accounts.js';
import { classifyAccount } from '../../pipeline/classifier.js';
import { requireApiKey } from '../auth.js';

export const accountsRouter = Router();

// List accounts with optional filter
accountsRouter.get('/', (req: Request, res: Response) => {
  const limit = clampInt(req.query['limit'], 200, 1, 1000);
  const classification = req.query['classification']
    ? String(req.query['classification']).toUpperCase() as Classification
    : undefined;
  const marathiOnly = String(req.query['marathiOnly'] ?? '') === 'true';
  res.json(listAccounts({ limit, classification, marathiOnly }));
});

// Single account by handle
accountsRouter.get('/:handle', (req: Request, res: Response) => {
  const handle = String(req.params['handle']);
  const account = getAccount(handle);
  if (!account) return res.status(404).json({ error: 'not found' });
  res.json(account);
});

// Force re-classify an account
accountsRouter.post('/:handle/classify', requireApiKey, async (req: Request, res: Response) => {
  const handle = String(req.params['handle']);
  try {
    const account = await classifyAccount(handle, null, { forceRefresh: true, fetchProfileIfMissing: true });
    res.json(account);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Aggregate engagement stats
accountsRouter.get('/_/stats', (_req: Request, res: Response) => {
  res.json(getInteractionStats());
});

// Recent interactions (replies we posted)
accountsRouter.get('/_/interactions', (req: Request, res: Response) => {
  const limit = clampInt(req.query['limit'], 50, 1, 500);
  res.json(listRecentInteractions(limit));
});

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
