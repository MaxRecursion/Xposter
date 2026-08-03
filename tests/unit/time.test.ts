import { describe, it, expect } from 'vitest';
import { startOfLocalDayUnix } from '../../src/utils/time.js';

describe('startOfLocalDayUnix', () => {
  it('returns unix seconds at local midnight', () => {
    const date = new Date(2026, 7, 3, 15, 30, 0); // Aug 3, 2026 15:30 local
    expect(startOfLocalDayUnix(date)).toBe(Math.floor(new Date(2026, 7, 3, 0, 0, 0).getTime() / 1000));
  });

  it('defaults to today', () => {
    const now = new Date();
    const expected = Math.floor(
      new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).getTime() / 1000,
    );
    expect(startOfLocalDayUnix()).toBe(expected);
  });
});
