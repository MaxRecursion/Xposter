/**
 * Chooses the framing for a trend reply.
 *
 * Two properties matter here:
 *
 * 1. Safety is absolute. If the topic isn't cleared for a contrarian take, the
 *    answer is ALIGNED — decided before any randomness is consulted, so there
 *    is exactly one place this can go wrong and it's easy to test.
 *
 * 2. The ratio has to actually hold. A per-call coin flip drifts badly here,
 *    because safety can force ALIGNED at any moment and those forced picks
 *    aren't compensated for. Reading what actually shipped today and filling
 *    the deficit self-corrects: five forced ALIGNEDs in a row make the next
 *    eligible trend contrarian.
 */
import { getStanceCountsToday, type Stance } from '../storage/queries.js';
import type { TrendSafetyClass } from '../trends/trend_filter.js';

export type { Stance };

export interface StanceDecision {
  stance: Stance;
  reason: string;
}

export interface DecideStanceOptions {
  safetyClass: TrendSafetyClass;
  /** Target share of replies that should be contrarian, 0-100. */
  targetPct: number;
  /** Injectable for tests; defaults to today's posted counts. */
  counts?: { aligned: number; contrarian: number };
}

export function decideStance(opts: DecideStanceOptions): StanceDecision {
  // Safety first, unconditionally. UNCLASSIFIED is not permission.
  if (opts.safetyClass !== 'SAFE_FOR_CONTRARIAN') {
    return { stance: 'ALIGNED', reason: `safety=${opts.safetyClass}` };
  }

  const target = Math.min(100, Math.max(0, opts.targetPct));
  if (target <= 0) return { stance: 'ALIGNED', reason: 'contrarian disabled' };
  if (target >= 100) return { stance: 'CONTRARIAN', reason: 'contrarian forced' };

  const counts = opts.counts ?? getStanceCountsToday();
  const total = counts.aligned + counts.contrarian;

  // The +1 treats this reply as already counted, so the very first reply of the
  // day compares 0/1 against the target instead of dividing by zero.
  const shareIfSkipped = counts.contrarian / (total + 1);

  if (shareIfSkipped < target / 100) {
    return {
      stance: 'CONTRARIAN',
      reason: `deficit ${(shareIfSkipped * 100).toFixed(0)}% < ${target}%`,
    };
  }
  return {
    stance: 'ALIGNED',
    reason: `quota met ${(shareIfSkipped * 100).toFixed(0)}% >= ${target}%`,
  };
}
