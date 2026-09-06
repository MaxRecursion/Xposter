import { getRedisClient, isCacheDisabled } from './redis.js';
import { logger } from '../utils/logger.js';

export async function get<T>(key: string): Promise<T | null> {
  if (isCacheDisabled()) return null;
  try {
    const raw = await getRedisClient().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err) {
    logger.debug('Cache get failed — treating as miss', { key, err: String(err) });
    return null;
  }
}

export async function set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  if (isCacheDisabled()) return;
  try {
    await getRedisClient().set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.debug('Cache set failed — continuing uncached', { key, err: String(err) });
  }
}

export async function del(key: string): Promise<void> {
  if (isCacheDisabled()) return;
  try {
    await getRedisClient().del(key);
  } catch (err) {
    logger.debug('Cache del failed', { key, err: String(err) });
  }
}

/**
 * Read-through cache: return the cached value if present, otherwise compute
 * it with `fn`, cache the result, and return it. `fn` always runs on a miss
 * OR when Redis itself is unavailable (get() fails closed to null).
 */
export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  const cached = await get<T>(key);
  if (cached !== null) return cached;
  const fresh = await fn();
  await set(key, fresh, ttlSeconds);
  return fresh;
}
