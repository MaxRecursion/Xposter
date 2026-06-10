import { describe, it, expect } from 'vitest';
import { detectUnfollows } from '../../src/scheduler/follower_sync.js';
import type { FollowerListEntry } from '../../src/browser/followers.js';

const entries = (...handles: string[]): FollowerListEntry[] =>
  handles.map((handle) => ({ handle, followedByUs: null }));

const known = (...handles: string[]): Map<string, string> =>
  new Map(handles.map((h) => [h.toLowerCase(), h]));

describe('detectUnfollows', () => {
  it('flags known followers missing from a complete scrape', () => {
    const result = detectUnfollows(known('Alice', 'Bob', 'Carol'), entries('alice', 'carol'));
    expect(result).toEqual(['Bob']);
  });

  it('returns original-case handles for DB writes', () => {
    const result = detectUnfollows(known('CamelCase_User', 'other'), entries('other'));
    expect(result).toEqual(['CamelCase_User']);
  });

  it('skips detection when the scrape hit the cap (truncated list)', () => {
    const big = Array.from({ length: 200 }, (_, i) => `user${i}`);
    expect(detectUnfollows(known('gone_user', ...big), entries(...big))).toEqual([]);
  });

  it('skips detection when the scrape looks like a partial page load', () => {
    const knownMap = known(...Array.from({ length: 100 }, (_, i) => `user${i}`));
    // Only 40 of 100 known followers scraped — suspect, not 60 unfollows
    expect(detectUnfollows(knownMap, entries(...Array.from({ length: 40 }, (_, i) => `user${i}`)))).toEqual([]);
  });

  it('handles empty inputs', () => {
    expect(detectUnfollows(new Map(), entries('a'))).toEqual([]);
    expect(detectUnfollows(known('a'), [])).toEqual([]);
  });
});
