import { describe, expect, it } from 'vitest';
import {
  baitGuidanceFor, decideEngagementBait, isBlockedForBait,
} from '../../src/pipeline/engagement_bait.js';

describe('isBlockedForBait', () => {
  it('blocks grief and health content', () => {
    expect(isBlockedForBait('RIP uncle, passed away this morning')).toBe(true);
    expect(isBlockedForBait('She was hospitalized after the crash')).toBe(true);
  });

  it('blocks identity third rails', () => {
    expect(isBlockedForBait('Caste politics ruined the hiring pipeline')).toBe(true);
    expect(isBlockedForBait('Temple vs mosque debate again')).toBe(true);
  });

  it('allows safe civic and tech topics', () => {
    expect(isBlockedForBait('PMC drainage failed again on FC Road')).toBe(false);
    expect(isBlockedForBait('Hinjewadi salaries are a mirage for juniors')).toBe(false);
  });
});

describe('decideEngagementBait', () => {
  it('forces NONE when blocked, even at 100% target', () => {
    const result = decideEngagementBait({
      targetPct: 100,
      blocked: true,
      counts: { bait: 0, normal: 0 },
    });
    expect(result.mode).toBe('NONE');
  });

  it('picks bait when below quota', () => {
    const result = decideEngagementBait({
      targetPct: 30,
      blocked: false,
      counts: { bait: 0, normal: 10 },
      rng: () => 0.1,
    });
    expect(result.mode).toBe('CLICKBAIT');
  });

  it('picks ragebait when RNG says so', () => {
    const result = decideEngagementBait({
      targetPct: 30,
      blocked: false,
      counts: { bait: 0, normal: 10 },
      rng: () => 0.9,
    });
    expect(result.mode).toBe('RAGEBAIT');
  });

  it('returns NONE when quota is already met', () => {
    const result = decideEngagementBait({
      targetPct: 30,
      blocked: false,
      counts: { bait: 5, normal: 5 },
    });
    expect(result.mode).toBe('NONE');
  });

  it('converges near 30% over a simulated day', () => {
    const counts = { bait: 0, normal: 0 };
    let click = 0;
    let rage = 0;
    for (let i = 0; i < 40; i++) {
      const { mode } = decideEngagementBait({
        targetPct: 30,
        blocked: false,
        counts,
        rng: () => (i % 2 === 0 ? 0.1 : 0.9),
      });
      if (mode === 'NONE') counts.normal++;
      else {
        counts.bait++;
        if (mode === 'CLICKBAIT') click++;
        else rage++;
      }
    }
    const share = counts.bait / 40;
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.38);
    expect(click).toBeGreaterThan(0);
    expect(rage).toBeGreaterThan(0);
  });

  it('self-corrects after a run of blocked NONE posts', () => {
    const counts = { bait: 0, normal: 8 };
    const { mode } = decideEngagementBait({
      targetPct: 30,
      blocked: false,
      counts,
      rng: () => 0.2,
    });
    expect(mode).toBe('CLICKBAIT');
  });
});

describe('baitGuidanceFor', () => {
  it('returns empty for NONE and substantive text for bait modes', () => {
    expect(baitGuidanceFor('NONE')).toBe('');
    expect(baitGuidanceFor('CLICKBAIT')).toMatch(/CLICKBAIT/);
    expect(baitGuidanceFor('RAGEBAIT')).toMatch(/RAGEBAIT/);
    expect(baitGuidanceFor('RAGEBAIT')).toMatch(/NEVER rage about/i);
  });
});
