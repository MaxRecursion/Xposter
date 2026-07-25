import { describe, expect, it } from 'vitest';
import { decideStance } from '../../src/pipeline/stance.js';
import type { TrendSafetyClass } from '../../src/trends/trend_filter.js';

const SAFE: TrendSafetyClass = 'SAFE_FOR_CONTRARIAN';

describe('decideStance — safety', () => {
  const unsafe: TrendSafetyClass[] = ['SKIP', 'STRAIGHT_ONLY', 'UNCLASSIFIED'];

  for (const safetyClass of unsafe) {
    it(`forces ALIGNED for ${safetyClass}, even at 100% contrarian target`, () => {
      const result = decideStance({ safetyClass, targetPct: 100, counts: { aligned: 0, contrarian: 0 } });
      expect(result.stance).toBe('ALIGNED');
      expect(result.reason).toContain(safetyClass);
    });
  }

  it('never returns CONTRARIAN for an unsafe class across many draws', () => {
    for (let i = 0; i < 200; i++) {
      const result = decideStance({
        safetyClass: 'STRAIGHT_ONLY',
        targetPct: 100,
        counts: { aligned: i, contrarian: 0 },
      });
      expect(result.stance).toBe('ALIGNED');
    }
  });
});

describe('decideStance — allocation', () => {
  it('goes contrarian when below quota', () => {
    const result = decideStance({ safetyClass: SAFE, targetPct: 33, counts: { aligned: 10, contrarian: 0 } });
    expect(result.stance).toBe('CONTRARIAN');
  });

  it('goes aligned when the quota is already met', () => {
    const result = decideStance({ safetyClass: SAFE, targetPct: 33, counts: { aligned: 2, contrarian: 5 } });
    expect(result.stance).toBe('ALIGNED');
  });

  it('honours the 0% and 100% extremes', () => {
    expect(decideStance({ safetyClass: SAFE, targetPct: 0, counts: { aligned: 0, contrarian: 0 } }).stance).toBe('ALIGNED');
    expect(decideStance({ safetyClass: SAFE, targetPct: 100, counts: { aligned: 0, contrarian: 0 } }).stance).toBe('CONTRARIAN');
  });

  it('converges on the target share over a simulated day', () => {
    const counts = { aligned: 0, contrarian: 0 };
    for (let i = 0; i < 30; i++) {
      const { stance } = decideStance({ safetyClass: SAFE, targetPct: 33, counts });
      if (stance === 'CONTRARIAN') counts.contrarian++;
      else counts.aligned++;
    }
    const share = counts.contrarian / 30;
    expect(share).toBeGreaterThan(0.28);
    expect(share).toBeLessThan(0.38);
  });

  it('self-corrects after safety forces a run of ALIGNED replies', () => {
    // Five unsafe trends in a row: those shipped as ALIGNED and were counted.
    const counts = { aligned: 5, contrarian: 0 };
    const { stance } = decideStance({ safetyClass: SAFE, targetPct: 33, counts });
    expect(stance).toBe('CONTRARIAN');
  });

  it('is deterministic for the same inputs', () => {
    const args = { safetyClass: SAFE, targetPct: 33, counts: { aligned: 4, contrarian: 1 } };
    const first = decideStance(args);
    for (let i = 0; i < 20; i++) expect(decideStance(args).stance).toBe(first.stance);
  });
});
