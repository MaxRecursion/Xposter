import { rssSource } from './rss.js';
import { redditSource } from './reddit.js';
import { weatherSource } from './weather.js';
import type { ContextSource } from '../types.js';

interface RssDef {
  kind: 'rss';
  name: string;
  envVar: string;
  defaultUrl: string;
  language: 'english' | 'marathi';
  credibility: number;
  intervalMinutes: number;
}

interface RedditDef {
  kind: 'reddit';
  name: string;
  envVar: string;
  defaultSubreddit: string;
  credibility: number;
  intervalMinutes: number;
}

interface WeatherDef {
  kind: 'weather';
  name: string;
  envVar: string;
  defaultLocation: string;
  credibility: number;
  intervalMinutes: number;
}

type SourceDef = RssDef | RedditDef | WeatherDef;

// Pune-focused defaults. Each is overridable via env. Setting an env var to an
// empty string disables that source.
//
// Notes from real-world probing:
//   - Loksatta has no public RSS endpoint anymore (every reasonable URL
//     returns HTML). Default is blank; set CONTEXT_RSS_LOKSATTA_PUNE if you
//     find a working URL.
//   - eSakal's public /feed exists but is paywalled and ships zero items.
//     Default is blank.
//   - The Indian Express Pune section feed is the most reliable English
//     source for Pune-local reporting (200+ items typically).
const SOURCES: SourceDef[] = [
  { kind: 'rss',     name: 'rss:loksatta-pune',       envVar: 'CONTEXT_RSS_LOKSATTA_PUNE', defaultUrl: '',                                                   language: 'marathi', credibility: 0.85, intervalMinutes: 30 },
  { kind: 'rss',     name: 'rss:indian-express-pune', envVar: 'CONTEXT_RSS_IE_PUNE',       defaultUrl: 'https://indianexpress.com/section/cities/pune/feed/', language: 'english', credibility: 0.85, intervalMinutes: 30 },
  { kind: 'rss',     name: 'rss:esakal-pune',         envVar: 'CONTEXT_RSS_ESAKAL_PUNE',   defaultUrl: '',                                                   language: 'marathi', credibility: 0.80, intervalMinutes: 30 },
  { kind: 'reddit',  name: 'reddit:pune',             envVar: 'CONTEXT_REDDIT_PUNE',       defaultSubreddit: 'pune',                                          credibility: 0.65, intervalMinutes: 45 },
  { kind: 'reddit',  name: 'reddit:india',            envVar: 'CONTEXT_REDDIT_INDIA',      defaultSubreddit: 'india',                                         credibility: 0.55, intervalMinutes: 60 },
  { kind: 'weather', name: 'weather:pune',            envVar: 'CONTEXT_WEATHER_PUNE',      defaultLocation: 'Pune',                                           credibility: 0.95, intervalMinutes: 90 },
];

export function buildContextSources(): ContextSource[] {
  const overrideMin = parseInt(process.env.CONTEXT_INGEST_INTERVAL_MIN ?? '', 10);
  const sources: ContextSource[] = [];

  for (const def of SOURCES) {
    const intervalMinutes = Number.isFinite(overrideMin) && overrideMin > 0 ? overrideMin : def.intervalMinutes;

    if (def.kind === 'rss') {
      const url = process.env[def.envVar] ?? def.defaultUrl;
      if (!url || url.trim() === '') continue;
      sources.push(rssSource({
        name: def.name,
        url,
        intervalMinutes,
        language: def.language,
        credibility: def.credibility,
      }));
    } else if (def.kind === 'reddit') {
      const sub = process.env[def.envVar] ?? def.defaultSubreddit;
      if (!sub || sub.trim() === '') continue;
      sources.push(redditSource({
        name: def.name,
        subreddit: sub,
        intervalMinutes,
        credibility: def.credibility,
      }));
    } else {
      const loc = process.env[def.envVar] ?? def.defaultLocation;
      if (!loc || loc.trim() === '') continue;
      sources.push(weatherSource({
        name: def.name,
        location: loc,
        intervalMinutes,
        credibility: def.credibility,
      }));
    }
  }

  return sources;
}
