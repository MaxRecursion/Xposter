import { getLatestHeatmap } from '../storage/audience.js';
import { logger } from '../utils/logger.js';

/**
 * Heatmap-aware slot sampling for both schedulers.
 *
 * `pickWeightedOffsetMinute` returns a minute offset inside [slotStart, slotEnd)
 * where each candidate minute is weighted by the audience-engagement intensity
 * of its (day-of-week, hour) cell. With no heatmap available, it degrades to
 * uniform random — matching the prior behavior exactly.
 *
 * WEIGHT_FLOOR keeps even cold cells reachable, so we never collapse to a
 * single deterministic minute even if every other cell is at zero.
 */

const WEIGHT_FLOOR = 0.15;
const CACHE_TTL_MS = 5 * 60_000;

let _cachedWeights: number[][] | null = null;
let _cachedAt = 0;

export function getHeatmapWeights(): number[][] | null {
  const now = Date.now();
  if (_cachedWeights && now - _cachedAt < CACHE_TTL_MS) return _cachedWeights;

  const latest = getLatestHeatmap();
  if (!latest) {
    _cachedWeights = null;
  } else {
    try {
      const parsed = JSON.parse(latest.cells_json) as number[][];
      if (Array.isArray(parsed) && parsed.length === 7 && parsed.every((row) => Array.isArray(row) && row.length === 24)) {
        _cachedWeights = parsed;
      } else {
        logger.warn('audience_heatmap cells_json has unexpected shape', {
          rows: parsed?.length, cols: parsed?.[0]?.length,
        });
        _cachedWeights = null;
      }
    } catch (err) {
      logger.warn('audience_heatmap cells_json parse failed', { err: String(err) });
      _cachedWeights = null;
    }
  }
  _cachedAt = now;
  return _cachedWeights;
}

export function invalidateHeatmapCache(): void {
  _cachedWeights = null;
  _cachedAt = 0;
}

/**
 * Picks a minute offset inside [slotStartMin, slotEndMin) (both relative to
 * `windowStartMs`), biased toward audience-active cells.
 */
export function pickWeightedOffsetMinute(
  windowStartMs: number,
  slotStartMin: number,
  slotEndMin: number,
): number {
  const slotSize = Math.max(1, slotEndMin - slotStartMin);
  const weights = getHeatmapWeights();
  if (!weights) {
    return slotStartMin + Math.floor(Math.random() * slotSize);
  }

  let total = 0;
  const cumulative: number[] = new Array(slotSize);
  for (let i = 0; i < slotSize; i++) {
    const minute = slotStartMin + i;
    const t = new Date(windowStartMs + minute * 60_000);
    const dow = t.getDay();
    const hour = t.getHours();
    const w = Math.max(WEIGHT_FLOOR, weights[dow]?.[hour] ?? WEIGHT_FLOOR);
    total += w;
    cumulative[i] = total;
  }

  const r = Math.random() * total;
  for (let i = 0; i < cumulative.length; i++) {
    if (r <= cumulative[i]) return slotStartMin + i;
  }
  return slotEndMin - 1;
}
