import { describe, expect, it } from 'vitest';
import { retryCountFromDetail, withRetryDetail } from '../../src/storage/scheduled_runs.js';

describe('scheduled run retry detail helpers', () => {
  it('defaults missing retry tokens to 0', () => {
    expect(retryCountFromDetail(null)).toBe(0);
    expect(retryCountFromDetail('ORIGINAL')).toBe(0);
  });

  it('reads retry=N from a detail string', () => {
    expect(retryCountFromDetail('ORIGINAL; transient: boom; retry=2')).toBe(2);
  });

  it('appends a retry token without duplicating it', () => {
    expect(withRetryDetail('ORIGINAL', 1)).toBe('ORIGINAL; retry=1');
    expect(withRetryDetail('ORIGINAL; retry=1', 2)).toBe('ORIGINAL; retry=2');
  });
});
