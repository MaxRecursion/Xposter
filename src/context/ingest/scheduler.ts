import type { ContextSource } from '../types.js';
import { ContextStore } from '../store/store.js';
import { sanitize } from './sanitize.js';
import { recordSourceRun } from './health.js';
import { logger } from '../../utils/logger.js';

const MIN_BODY_CHARS = 40;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const INITIAL_JITTER_MS = 30_000;

interface RunningTask {
  source: string;
  interval: NodeJS.Timeout;
  initial: NodeJS.Timeout;
}

let _runningTasks: RunningTask[] = [];
let _pruneTimer: NodeJS.Timeout | null = null;
const _inflight = new Set<string>();

export function startContextIngest(sources: ContextSource[], store: ContextStore): void {
  if (_runningTasks.length > 0) {
    logger.warn('Context ingest already started — ignoring duplicate start');
    return;
  }

  for (const src of sources) {
    const intervalMs = Math.max(60_000, src.intervalMinutes * 60_000);
    const jitter = 5_000 + Math.floor(Math.random() * INITIAL_JITTER_MS);

    const initial = setTimeout(() => { void runOnce(src, store); }, jitter);
    const interval = setInterval(() => { void runOnce(src, store); }, intervalMs);
    _runningTasks.push({ source: src.name, interval, initial });

    logger.info('Context source scheduled', {
      source: src.name,
      intervalMin: src.intervalMinutes,
      firstRunInMs: jitter,
    });
  }

  _pruneTimer = setInterval(() => {
    try {
      store.pruneExpired();
    } catch (err) {
      logger.warn('Context prune failed', { err: String(err) });
    }
  }, PRUNE_INTERVAL_MS);
}

export function stopContextIngest(): void {
  for (const t of _runningTasks) {
    clearTimeout(t.initial);
    clearInterval(t.interval);
  }
  _runningTasks = [];
  if (_pruneTimer) {
    clearInterval(_pruneTimer);
    _pruneTimer = null;
  }
}

async function runOnce(src: ContextSource, store: ContextStore): Promise<void> {
  if (_inflight.has(src.name)) {
    logger.debug('Context source already running — skipping overlap', { source: src.name });
    return;
  }
  _inflight.add(src.name);
  const start = Date.now();

  try {
    const result = await src.fetch();
    const cleaned = result.items
      .map((it) => ({
        ...it,
        title: it.title ? sanitize(it.title) : null,
        body: sanitize(it.body),
      }))
      .filter((it) => it.body.length >= MIN_BODY_CHARS);

    const inserted = await store.upsertAndEmbed(cleaned);
    recordSourceRun(src.name, true, null);
    logger.info('Context source ok', {
      source: src.name,
      fetched: result.items.length,
      kept: cleaned.length,
      inserted,
      ms: Date.now() - start,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordSourceRun(src.name, false, msg);
    logger.warn('Context source failed', { source: src.name, err: msg, ms: Date.now() - start });
  } finally {
    _inflight.delete(src.name);
  }
}
