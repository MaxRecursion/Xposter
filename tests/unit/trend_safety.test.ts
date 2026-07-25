import { describe, expect, it } from 'vitest';
import {
  classifyTrendSafety, combineSafety, expandTrendText,
} from '../../src/trends/trend_filter.js';

describe('classifyTrendSafety — SKIP', () => {
  const cases = [
    ['#RIPSushant', 'death'],
    ['Condolences', 'death'],
    ['funeral procession', 'death'],
    ['Bengaluru stampede', 'disaster'],
    ['plane crash', 'disaster'],
    ['#DelhiBlast', 'disaster'],
    ['earthquake', 'disaster'],
    ['train derailed', 'disaster'],
    ['murder accused arrested', 'violence'],
    ['terror attack', 'violence'],
    ['school shooting', 'violence'],
    ['#JusticeForNirbhaya rape case', 'violence'],
  ];

  for (const [text, reason] of cases) {
    it(`skips "${text}" (${reason})`, () => {
      expect(classifyTrendSafety(text).class).toBe('SKIP');
    });
  }
});

describe('classifyTrendSafety — STRAIGHT_ONLY', () => {
  const cases = [
    // Real trends from the live worldwide/India feeds that were originally
    // misclassified as safe for a contrarian take.
    ['Sant Rampal Ji Maharaj', 'religion'],
    ['#DharmendraPradhan', 'politics'],
    ['#CMSamratForViksitBihar', 'politics'],
    ['#TimeToEndProtest', 'unrest'],
    // Category coverage
    ['cancer treatment', 'health'],
    ['Diwali celebrations', 'religion'],
    ['temple visit', 'religion'],
    ['reservation policy', 'caste'],
    ['army jawan', 'military'],
    ['Rahul Gandhi speech', 'politics'],
    ['Lok Sabha session', 'politics'],
    ['farmers bandh', 'unrest'],
  ];

  for (const [text, reason] of cases) {
    it(`marks "${text}" straight-only (${reason})`, () => {
      const result = classifyTrendSafety(text);
      expect(result.class).toBe('STRAIGHT_ONLY');
      expect(result.reason).toBe(reason);
    });
  }
});

describe('classifyTrendSafety — SAFE_FOR_CONTRARIAN', () => {
  const cases = [
    '#Formula1',
    'BADBADNOTGOOD',
    'Khruangbin',
    'Persib vs Arema',
    '#WWDC',
    'quarterly earnings',
    'new iPhone',
  ];

  for (const text of cases) {
    it(`allows a contrarian take on "${text}"`, () => {
      expect(classifyTrendSafety(text).class).toBe('SAFE_FOR_CONTRARIAN');
    });
  }
});

describe('classifyTrendSafety — deny by default', () => {
  it('treats empty input as straight-only, never safe', () => {
    expect(classifyTrendSafety('').class).toBe('STRAIGHT_ONLY');
    expect(classifyTrendSafety('   ').class).toBe('STRAIGHT_ONLY');
  });

  it('classifies the tweet body, not just the trend name', () => {
    // A safe trend can still surface a tweet about a death.
    expect(classifyTrendSafety('Absolutely gutted, he passed away this morning').class).toBe('SKIP');
  });
});

describe('expandTrendText', () => {
  it('splits concatenated camelCase hashtags so word boundaries can match', () => {
    expect(expandTrendText('#CMSamratForViksitBihar')).toBe('CM Samrat For Viksit Bihar');
  });

  it('keeps leading acronyms together', () => {
    expect(expandTrendText('#IPLFinal')).toBe('IPL Final');
  });

  it('splits underscore-joined tags', () => {
    expect(expandTrendText('#time_to_end_protest')).toBe('time to end protest');
  });
});

describe('combineSafety', () => {
  it('takes the more restrictive of the two', () => {
    expect(combineSafety('SAFE_FOR_CONTRARIAN', 'SKIP')).toBe('SKIP');
    expect(combineSafety('SKIP', 'SAFE_FOR_CONTRARIAN')).toBe('SKIP');
    expect(combineSafety('SAFE_FOR_CONTRARIAN', 'STRAIGHT_ONLY')).toBe('STRAIGHT_ONLY');
    expect(combineSafety('SAFE_FOR_CONTRARIAN', 'SAFE_FOR_CONTRARIAN')).toBe('SAFE_FOR_CONTRARIAN');
  });

  it('never resolves UNCLASSIFIED into permission', () => {
    expect(combineSafety('UNCLASSIFIED', 'SAFE_FOR_CONTRARIAN')).toBe('STRAIGHT_ONLY');
    expect(combineSafety('SAFE_FOR_CONTRARIAN', 'UNCLASSIFIED')).toBe('STRAIGHT_ONLY');
  });
});
