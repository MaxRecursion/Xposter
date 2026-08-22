import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildContextSources, listContextSourceCatalog } from '../../src/context/sources/index.js';

const ENV_KEYS = [
  'CONTEXT_INGEST_INTERVAL_MIN',
  'CONTEXT_RSS_LOKSATTA_PUNE',
  'CONTEXT_RSS_IE_PUNE',
  'CONTEXT_RSS_HT_PUNE',
  'CONTEXT_RSS_TOI_PUNE',
  'CONTEXT_RSS_ESAKAL_PUNE',
  'CONTEXT_RSS_IE_AI',
  'CONTEXT_RSS_IE_ECONOMY',
  'CONTEXT_RSS_IE_JOBS',
  'CONTEXT_RSS_IE_WORKPLACE',
  'CONTEXT_RSS_MINT_AI',
  'CONTEXT_RSS_MINT_INDUSTRY',
  'CONTEXT_RSS_RBI_PRESS',
  'CONTEXT_RSS_INC42',
  'CONTEXT_RSS_INC42_AI_SHIFT',
  'CONTEXT_RSS_INC42_STARTUPS',
  'CONTEXT_RSS_YOURSTORY',
  'CONTEXT_RSS_GUARDIAN_WORLD',
  'CONTEXT_RSS_ALJAZEERA',
  'CONTEXT_RSS_IE_INDIA',
  'CONTEXT_RSS_HINDU_INDIA',
  'CONTEXT_RSS_IE_TECH',
  'CONTEXT_RSS_ET_TECH',
  'CONTEXT_RSS_ET_ECONOMY',
  'CONTEXT_RSS_ET_STARTUPS',
  'CONTEXT_RSS_MINT_TECH',
  'CONTEXT_RSS_GOOGLE_AI',
  'CONTEXT_RSS_DEEPMIND',
  'CONTEXT_RSS_SEMIANALYSIS',
  'CONTEXT_RSS_MIT_TECH_REVIEW',
  'CONTEXT_RSS_BBC_TECH',
  'CONTEXT_RSS_NDTV_INDIA',
  'CONTEXT_RSS_ESPNCRICINFO',
  'CONTEXT_RSS_TECHCRUNCH',
  'CONTEXT_RSS_TECHCRUNCH_AI',
  'CONTEXT_RSS_VENTUREBEAT_AI',
  'CONTEXT_RSS_WIRED',
  'CONTEXT_RSS_BBC_WORLD',
  'CONTEXT_REDDIT_PUNE',
  'CONTEXT_REDDIT_INDIA',
  'CONTEXT_REDDIT_STARTUPS',
  'CONTEXT_WEATHER_PUNE',
];

const savedEnv = new Map<string, string | undefined>();

describe('buildContextSources', () => {
  beforeEach(() => {
    savedEnv.clear();
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('includes the related Pune / work / AI brain by default', () => {
    const names = buildContextSources().map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining([
      'rss:indian-express-pune',
      'rss:hindustan-times-pune',
      'rss:toi-pune',
      'rss:indian-express-ai',
      'rss:indian-express-economy',
      'rss:indian-express-jobs',
      'rss:rbi-press',
      'rss:inc42',
      'rss:techcrunch-ai',
      'weather:pune',
      'reddit:pune',
    ]));
  });

  it('does not ingest unrelated geopolitics, gadgets, or sports by default', () => {
    const names = buildContextSources().map((s) => s.name);
    expect(names).not.toContain('rss:guardian-world');
    expect(names).not.toContain('rss:aljazeera');
    expect(names).not.toContain('rss:espncricinfo');
    expect(names).not.toContain('rss:techcrunch');
    expect(names).not.toContain('reddit:india');
  });

  it('keeps opt-in sources listed in the catalog', () => {
    const optIn = listContextSourceCatalog().filter((row) => !row.inBrain);
    expect(optIn.map((row) => row.name)).toEqual(expect.arrayContaining([
      'rss:guardian-world',
      'rss:espncricinfo',
    ]));
    expect(optIn.every((row) => !row.active)).toBe(true);
  });

  it('uses the working NDTV India feed URL by default', () => {
    const ndtv = buildContextSources().find((s) => s.name === 'rss:ndtv-india');
    expect(ndtv).toBeDefined();
    expect(ndtv?.fetch).toBeTypeOf('function');
    expect(ndtv?.cluster).toBe('india-work');
  });

  it('allows individual feeds to be disabled with an empty env var', () => {
    process.env.CONTEXT_RSS_INC42 = '';
    process.env.CONTEXT_RSS_YOURSTORY = '';
    const names = buildContextSources().map((s) => s.name);
    expect(names).not.toContain('rss:inc42');
    expect(names).not.toContain('rss:yourstory');
    expect(names).toContain('rss:inc42-ai-shift');
  });

  it('enables an opt-in source when the env URL is set', () => {
    process.env.CONTEXT_RSS_GUARDIAN_WORLD = 'https://www.theguardian.com/world/rss';
    const names = buildContextSources().map((s) => s.name);
    expect(names).toContain('rss:guardian-world');
  });
});
