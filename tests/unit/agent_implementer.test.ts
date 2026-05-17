import { describe, it, expect } from 'vitest';
import { extractPrUrl } from '../../src/agent/implementer.js';

describe('extractPrUrl', () => {
  it('extracts a PR URL from the agent final message', () => {
    const text = `All done!

DONE: https://github.com/MaxRecursion/Xposter/pull/42`;
    expect(extractPrUrl(text)).toBe('https://github.com/MaxRecursion/Xposter/pull/42');
  });

  it('handles a PR URL embedded in prose', () => {
    const text = 'PR is up at https://github.com/owner/repo/pull/1 — please review.';
    expect(extractPrUrl(text)).toBe('https://github.com/owner/repo/pull/1');
  });

  it('returns null when no PR URL present', () => {
    expect(extractPrUrl('I was unable to complete the task.')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractPrUrl('')).toBeNull();
  });

  it('matches https but not other URLs', () => {
    const text = 'See https://example.com/pull/1 for context.';
    expect(extractPrUrl(text)).toBeNull();
  });
});
