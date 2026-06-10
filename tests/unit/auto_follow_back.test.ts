import { describe, it, expect } from 'vitest';
import { shouldAutoFollowBack, type AutoFollowBackConfig } from '../../src/scheduler/follower_sync.js';

const cfg = (over: Partial<AutoFollowBackConfig> = {}): AutoFollowBackConfig => ({
  enabled: true,
  classifications: new Set(['REGULAR', 'SERIOUS']),
  minConfidencePct: 60,
  ...over,
});

describe('shouldAutoFollowBack', () => {
  it('approves allowed classification above the confidence threshold', () => {
    expect(shouldAutoFollowBack(cfg(), 'REGULAR', 0.8)).toBe(true);
    expect(shouldAutoFollowBack(cfg(), 'serious', 0.61)).toBe(true);
  });

  it('rejects when disabled', () => {
    expect(shouldAutoFollowBack(cfg({ enabled: false }), 'REGULAR', 0.9)).toBe(false);
  });

  it('rejects classifications outside the allowlist', () => {
    expect(shouldAutoFollowBack(cfg(), 'BOT', 0.99)).toBe(false);
    expect(shouldAutoFollowBack(cfg(), 'BRAND_PROMO', 0.99)).toBe(false);
    expect(shouldAutoFollowBack(cfg(), null, 0.99)).toBe(false);
  });

  it('rejects below the confidence threshold (exact threshold passes)', () => {
    expect(shouldAutoFollowBack(cfg(), 'REGULAR', 0.59)).toBe(false);
    expect(shouldAutoFollowBack(cfg(), 'REGULAR', 0.6)).toBe(true);
  });
});
