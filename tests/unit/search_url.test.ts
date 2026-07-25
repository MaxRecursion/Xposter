import { describe, expect, it } from 'vitest';
import { buildSearchUrl } from '../../src/browser/ingestion.js';

const paramsOf = (url: string) => new URL(url).searchParams;

describe('buildSearchUrl', () => {
  it('builds a Top-tab search by default', () => {
    const url = buildSearchUrl('artificial intelligence');
    expect(paramsOf(url).get('q')).toBe('artificial intelligence');
    expect(paramsOf(url).get('f')).toBe('top');
    expect(paramsOf(url).get('src')).toBe('typed_query');
  });

  it('uses the live tab for Latest', () => {
    expect(paramsOf(buildSearchUrl('x', 'Latest')).get('f')).toBe('live');
  });

  it('decodes a pre-encoded trends query instead of double-escaping it', () => {
    // The trends API returns `query` percent-encoded. Re-encoding it directly
    // would search for the literal text "%23DharmendraPradhan".
    const url = buildSearchUrl('%23DharmendraPradhan');
    expect(paramsOf(url).get('q')).toBe('#DharmendraPradhan');
    expect(url).not.toContain('%2523');
  });

  it('handles multi-word encoded queries', () => {
    expect(paramsOf(buildSearchUrl('Sant%20Rampal%20Ji')).get('q')).toBe('Sant Rampal Ji');
  });

  it('leaves a plain hashtag intact', () => {
    expect(paramsOf(buildSearchUrl('#INDvAUS')).get('q')).toBe('#INDvAUS');
  });

  it('survives a malformed escape sequence rather than throwing', () => {
    expect(() => buildSearchUrl('100%')).not.toThrow();
    expect(paramsOf(buildSearchUrl('100%')).get('q')).toBe('100%');
  });

  it('encodes operators so they reach X as query text', () => {
    const url = buildSearchUrl('AI OR "machine learning"');
    expect(paramsOf(url).get('q')).toBe('AI OR "machine learning"');
  });

  it('handles non-latin queries without corrupting them', () => {
    expect(paramsOf(buildSearchUrl('%E0%A4%AA%E0%A5%81%E0%A4%A3%E0%A5%87')).get('q')).toBe('पुणे');
  });
});
