import { rssSource } from './rss.js';
import type { ContextSource } from '../types.js';

interface FeedDef {
  name: string;
  envVar: string;
  defaultUrl: string;
  language: 'english' | 'marathi';
  credibility: number;
  intervalMinutes: number;
}

// Pune-focused feeds. Each is overridable via env. Setting an env var to an empty
// string disables that source.
const FEEDS: FeedDef[] = [
  {
    name: 'rss:loksatta-pune',
    envVar: 'CONTEXT_RSS_LOKSATTA_PUNE',
    defaultUrl: 'https://www.loksatta.com/pune/feed/',
    language: 'marathi',
    credibility: 0.85,
    intervalMinutes: 30,
  },
  {
    name: 'rss:indian-express-pune',
    envVar: 'CONTEXT_RSS_IE_PUNE',
    defaultUrl: 'https://indianexpress.com/section/cities/pune/feed/',
    language: 'english',
    credibility: 0.85,
    intervalMinutes: 30,
  },
  {
    name: 'rss:esakal-pune',
    envVar: 'CONTEXT_RSS_ESAKAL_PUNE',
    defaultUrl: 'https://www.esakal.com/pune.feed',
    language: 'marathi',
    credibility: 0.80,
    intervalMinutes: 30,
  },
];

export function buildContextSources(): ContextSource[] {
  const overrideMin = parseInt(process.env.CONTEXT_INGEST_INTERVAL_MIN ?? '', 10);
  const sources: ContextSource[] = [];

  for (const f of FEEDS) {
    const url = process.env[f.envVar] ?? f.defaultUrl;
    if (!url || url.trim() === '') continue;
    sources.push(rssSource({
      name: f.name,
      url,
      intervalMinutes: Number.isFinite(overrideMin) && overrideMin > 0 ? overrideMin : f.intervalMinutes,
      language: f.language,
      credibility: f.credibility,
    }));
  }

  return sources;
}
