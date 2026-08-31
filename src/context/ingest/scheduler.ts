import type { ContextSource } from '../types.js';
import { ContextStore } from '../store/store.js';
import { sanitize } from './sanitize.js';
import { getConsecutiveFailures, recordSourceRun } from './health.js';
import { logger } from '../../utils/logger.js';

const MIN_BODY_CHARS = 40;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const INITIAL_JITTER_MS = 30_000;
/** Consecutive failures before a source is put on probe-only ticks. */
const BREAKER_THRESHOLD = 10;
/** Probe at least this often, so a recovered source is never abandoned. */
const BREAKER_MAX_BACKOFF = 64;

/** Tick counter per source, used only while a source is inside the breaker. */
const _tickCounts = new Map<string, number>();

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
  _tickCounts.clear();
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

  // Circuit breaker for permanently dead sources. Past the threshold a source
  // is probed on a fraction of its ticks instead of every one, so a feed that
  // has 403'd thousands of times in a row stops spending a request each cycle
  // but still recovers on its own if it ever comes back.
  const failures = getConsecutiveFailures(src.name);
  if (failures >= BREAKER_THRESHOLD) {
    const probeEvery = Math.min(BREAKER_MAX_BACKOFF, 2 ** Math.min(10, Math.floor(failures / BREAKER_THRESHOLD)));
    const tick = (_tickCounts.get(src.name) ?? 0) + 1;
    _tickCounts.set(src.name, tick);
    if (tick % probeEvery !== 0) {
      logger.debug('Context source in breaker — skipping tick', {
        source: src.name, failures, probeEvery,
      });
      return;
    }
    logger.info('Context source breaker probe', { source: src.name, failures });
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
