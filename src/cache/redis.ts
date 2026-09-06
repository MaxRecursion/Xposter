import { Redis } from 'ioredis';
import { getRedisUrl } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Caching is a pure optimization on top of correct behavior — if Redis is
 * unreachable, every cache operation must fail closed (silent miss / no-op)
 * rather than throwing or hanging whatever pipeline called it.
 *
 * `enableOfflineQueue: false` + `maxRetriesPerRequest: 1` make that failure
 * fast: a command issued while disconnected rejects immediately instead of
 * queuing forever waiting for a reconnect that may never come.
 */
let _client: Redis | null = null;
let _warned = false;

/**
 * vitest sets this in every worker process. A real Redis instance is external
 * state that would otherwise survive `vi.resetModules()` between test files,
 * letting one test's cached value leak into another's assertions — so tests
 * always run as if Redis were absent.
 */
export function isCacheDisabled(): boolean {
  return Boolean(process.env.VITEST);
}

export function getRedisClient(): Redis {
  if (_client) return _client;

  _client = new Redis(getRedisUrl(), {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  });

  _client.on('error', (err) => {
    if (!_warned) {
      logger.warn('Redis unavailable — running uncached until it recovers', { err: String(err) });
      _warned = true;
    }
  });

  _client.on('ready', () => {
    if (_warned) {
      logger.info('Redis connection recovered — caching re-enabled');
      _warned = false;
    }
  });

  _client.connect().catch(() => {
    // The 'error' listener above already logged; callers see this as a
    // rejected get/set and treat it as a cache miss.
  });

  return _client;
}
