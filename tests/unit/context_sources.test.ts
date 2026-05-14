import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildContextSources } from '../../src/context/sources/index.js';

const ENV_KEYS = [
  'CONTEXT_INGEST_INTERVAL_MIN',
  'CONTEXT_RSS_LOKSATTA_PUNE',
  'CONTEXT_RSS_IE_PUNE',
  'CONTEXT_RSS_HT_PUNE',
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
  'CONTEXT_REDDIT_PUNE',
  'CONTEXT_REDDIT_INDIA',
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

  it('includes Pune, AI/jobs, startup, and macro economy RSS feeds by default', () => {
    const names = buildContextSources().map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining([
      'rss:indian-express-pune',
      'rss:hindustan-times-pune',
      'rss:indian-express-ai',
      'rss:indian-express-economy',
      'rss:indian-express-jobs',
      'rss:indian-express-workplace',
      'rss:mint-ai',
      'rss:mint-industry',
      'rss:rbi-press',
      'rss:inc42',
      'rss:inc42-ai-shift',
      'rss:inc42-startups',
      'rss:yourstory',
    ]));
  });

  it('allows individual feeds to be disabled with an empty env var', () => {
    process.env.CONTEXT_RSS_INC42 = '';
    process.env.CONTEXT_RSS_YOURSTORY = '';
    const names = buildContextSources().map((s) => s.name);
    expect(names).not.toContain('rss:inc42');
    expect(names).not.toContain('rss:yourstory');
    expect(names).toContain('rss:inc42-ai-shift');
  });
});
