import { describe, expect, it } from 'vitest';
import { detectScript, isUsableScript } from '../../src/trends/trend_filter.js';
import { filterTrendPost } from '../../src/pipeline/filter.js';

describe('detectScript', () => {
  const cases: Array<[string, string]> = [
    ['#DharmendraPradhan', 'latin'],
    ['Khruangbin', 'latin'],
    ['#FileninSultanları', 'latin'],   // Turkish — latin script, not English
    ['Persib vs Arema', 'latin'],
    ['#गौ_सुरक्षा_अभियान', 'devanagari'],
    ['धर्मेंद्र प्रधान', 'devanagari'],
    ['#土ドラ告白', 'cjk'],
    ['クルアンビン', 'cjk'],
    ['花火大会', 'cjk'],
    ['الرياض', 'arabic'],
    ['Москва', 'cyrillic'],
    ['กรุงเทพ', 'thai'],
  ];

  for (const [name, expected] of cases) {
    it(`classifies "${name}" as ${expected}`, () => {
      expect(detectScript(name)).toBe(expected);
    });
  }

  it('returns unknown for names with no letters at all', () => {
    expect(detectScript('#123')).toBe('unknown');
    expect(detectScript('🔥🔥')).toBe('unknown');
  });

  it('ignores the hash, digits and emoji when deciding', () => {
    expect(detectScript('#IPL2026🏏')).toBe('latin');
  });
});

describe('isUsableScript', () => {
  it('accepts latin for both locations, including Indian latin trends', () => {
    expect(isUsableScript('#INDvAUS')).toBe(true);
    expect(isUsableScript('Bengaluru')).toBe(true);
  });

  it('rejects scripts the English-only persona cannot reply in', () => {
    expect(isUsableScript('#गौ_सुरक्षा_अभियान')).toBe(false);
    expect(isUsableScript('花火大会')).toBe(false);
  });
});

describe('filterTrendPost', () => {
  it('passes a substantial English post with no topic keyword', () => {
    // The whole point: no Pune/tech keyword required — the trend is the relevance signal.
    const result = filterTrendPost(
      'The new pricing model completely changes the calculus for small teams building on this platform.',
    );
    expect(result.pass).toBe(true);
    expect(result.language).toBe('english');
  });

  it('rejects non-English posts', () => {
    expect(filterTrendPost('आज पुण्यात खूप पाऊस आहे आणि रस्ते पूर्ण तुंबले आहेत').pass).toBe(false);
  });

  it('rejects posts that are too short to reply to', () => {
    const result = filterTrendPost('This is great news');
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/too short/);
  });

  it('rejects link-and-hashtag spam that only looks long enough', () => {
    const result = filterTrendPost(
      'https://example.com/some/very/long/path #trending #viral #fyp #explore @someone @another',
    );
    expect(result.pass).toBe(false);
  });

  it('does not count hashtags and mentions toward the substance minimum', () => {
    const result = filterTrendPost('#AI #tech #future @openai @google @meta @apple @amazon');
    expect(result.pass).toBe(false);
  });
});
