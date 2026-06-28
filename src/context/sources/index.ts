import { rssSource } from './rss.js';
import { redditSource } from './reddit.js';
import { weatherSource } from './weather.js';
import { twitterSearchSource } from './twitter_search.js';
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

interface TwitterDef {
  kind: 'twitter';
  name: string;
  /** Optional env var — set to empty string to disable this source. */
  envVar?: string;
  query: string;
  credibility: number;
  intervalMinutes: number;
  maxTweets?: number;
}

type SourceDef = RssDef | RedditDef | WeatherDef | TwitterDef;

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
  { kind: 'rss',     name: 'rss:hindustan-times-pune', envVar: 'CONTEXT_RSS_HT_PUNE',      defaultUrl: 'https://www.hindustantimes.com/feeds/rss/cities/pune-news/rssfeed.xml', language: 'english', credibility: 0.82, intervalMinutes: 30 },
  { kind: 'rss',     name: 'rss:esakal-pune',         envVar: 'CONTEXT_RSS_ESAKAL_PUNE',   defaultUrl: '',                                                   language: 'marathi', credibility: 0.80, intervalMinutes: 30 },
  { kind: 'rss',     name: 'rss:indian-express-ai',   envVar: 'CONTEXT_RSS_IE_AI',         defaultUrl: 'https://indianexpress.com/section/technology/artificial-intelligence/feed/', language: 'english', credibility: 0.82, intervalMinutes: 45 },
  { kind: 'rss',     name: 'rss:indian-express-economy', envVar: 'CONTEXT_RSS_IE_ECONOMY', defaultUrl: 'https://indianexpress.com/section/business/economy/feed/', language: 'english', credibility: 0.82, intervalMinutes: 45 },
  { kind: 'rss',     name: 'rss:indian-express-jobs', envVar: 'CONTEXT_RSS_IE_JOBS',       defaultUrl: 'https://indianexpress.com/section/jobs/feed/', language: 'english', credibility: 0.78, intervalMinutes: 60 },
  { kind: 'rss',     name: 'rss:indian-express-workplace', envVar: 'CONTEXT_RSS_IE_WORKPLACE', defaultUrl: 'https://indianexpress.com/section/lifestyle/workplace/feed/', language: 'english', credibility: 0.75, intervalMinutes: 60 },
  { kind: 'rss',     name: 'rss:mint-ai',              envVar: 'CONTEXT_RSS_MINT_AI',      defaultUrl: 'https://www.livemint.com/rss/AI', language: 'english', credibility: 0.82, intervalMinutes: 45 },
  { kind: 'rss',     name: 'rss:mint-industry',        envVar: 'CONTEXT_RSS_MINT_INDUSTRY', defaultUrl: 'https://www.livemint.com/rss/industry', language: 'english', credibility: 0.82, intervalMinutes: 60 },
  { kind: 'rss',     name: 'rss:rbi-press',            envVar: 'CONTEXT_RSS_RBI_PRESS',    defaultUrl: 'https://rbi.org.in/pressreleases_rss.xml', language: 'english', credibility: 0.98, intervalMinutes: 120 },
  { kind: 'rss',     name: 'rss:inc42',                envVar: 'CONTEXT_RSS_INC42',        defaultUrl: 'https://inc42.com/feed/', language: 'english', credibility: 0.78, intervalMinutes: 60 },
  { kind: 'rss',     name: 'rss:inc42-ai-shift',       envVar: 'CONTEXT_RSS_INC42_AI_SHIFT', defaultUrl: 'https://inc42.com/tag/the-ai-shift/feed/', language: 'english', credibility: 0.80, intervalMinutes: 120 },
  { kind: 'rss',     name: 'rss:inc42-startups',       envVar: 'CONTEXT_RSS_INC42_STARTUPS', defaultUrl: 'https://inc42.com/startups/feed/', language: 'english', credibility: 0.78, intervalMinutes: 120 },
  { kind: 'rss',     name: 'rss:yourstory',            envVar: 'CONTEXT_RSS_YOURSTORY',    defaultUrl: 'https://yourstory.com/feed', language: 'english', credibility: 0.74, intervalMinutes: 120 },
  // ── Global AI / Tech ────────────────────────────────────────────────────────
  { kind: 'rss',     name: 'rss:techcrunch',           envVar: 'CONTEXT_RSS_TECHCRUNCH',     defaultUrl: 'https://techcrunch.com/feed/',                          language: 'english', credibility: 0.82, intervalMinutes: 30 },
  { kind: 'rss',     name: 'rss:techcrunch-ai',        envVar: 'CONTEXT_RSS_TECHCRUNCH_AI',  defaultUrl: 'https://techcrunch.com/category/artificial-intelligence/feed/', language: 'english', credibility: 0.82, intervalMinutes: 30 },
  { kind: 'rss',     name: 'rss:venturebeat-ai',       envVar: 'CONTEXT_RSS_VENTUREBEAT_AI', defaultUrl: 'https://venturebeat.com/category/ai/feed/',              language: 'english', credibility: 0.80, intervalMinutes: 45 },
  { kind: 'rss',     name: 'rss:wired',                envVar: 'CONTEXT_RSS_WIRED',          defaultUrl: 'https://www.wired.com/feed/rss',                        language: 'english', credibility: 0.82, intervalMinutes: 60 },
  { kind: 'rss',     name: 'rss:arstechnica',          envVar: 'CONTEXT_RSS_ARSTECHNICA',    defaultUrl: 'https://feeds.arstechnica.com/arstechnica/index',       language: 'english', credibility: 0.83, intervalMinutes: 60 },
  { kind: 'rss',     name: 'rss:theverge',             envVar: 'CONTEXT_RSS_THEVERGE',       defaultUrl: 'https://www.theverge.com/rss/index.xml',               language: 'english', credibility: 0.80, intervalMinutes: 45 },
  { kind: 'rss',     name: 'rss:hackernews',           envVar: 'CONTEXT_RSS_HACKERNEWS',     defaultUrl: 'https://hnrss.org/frontpage',                          language: 'english', credibility: 0.78, intervalMinutes: 30 },
  // ── Open-source / AI Coding ─────────────────────────────────────────────────
  { kind: 'rss',     name: 'rss:github-blog',          envVar: 'CONTEXT_RSS_GITHUB_BLOG',    defaultUrl: 'https://github.blog/feed/',                            language: 'english', credibility: 0.85, intervalMinutes: 120 },
  // ── SpaceX / EV / Elon Musk ─────────────────────────────────────────────────
  { kind: 'rss',     name: 'rss:electrek',             envVar: 'CONTEXT_RSS_ELECTREK',       defaultUrl: 'https://electrek.co/feed/',                            language: 'english', credibility: 0.80, intervalMinutes: 45 },
  { kind: 'rss',     name: 'rss:teslarati',            envVar: 'CONTEXT_RSS_TESLARATI',      defaultUrl: 'https://www.teslarati.com/feed/',                      language: 'english', credibility: 0.75, intervalMinutes: 60 },
  { kind: 'rss',     name: 'rss:spacenews',            envVar: 'CONTEXT_RSS_SPACENEWS',      defaultUrl: 'https://spacenews.com/feed/',                          language: 'english', credibility: 0.85, intervalMinutes: 60 },
  // ── Consumer Electronics ─────────────────────────────────────────────────────
  { kind: 'rss',     name: 'rss:gsmarena',             envVar: 'CONTEXT_RSS_GSMARENA',       defaultUrl: 'https://www.gsmarena.com/rss-news-reviews.php3',        language: 'english', credibility: 0.78, intervalMinutes: 60 },
  { kind: 'rss',     name: 'rss:9to5mac',              envVar: 'CONTEXT_RSS_9TO5MAC',        defaultUrl: 'https://9to5mac.com/feed/',                            language: 'english', credibility: 0.78, intervalMinutes: 60 },
  // ── Geopolitics ─────────────────────────────────────────────────────────────
  { kind: 'rss',     name: 'rss:bbc-world',            envVar: 'CONTEXT_RSS_BBC_WORLD',      defaultUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml',          language: 'english', credibility: 0.90, intervalMinutes: 30 },
  { kind: 'rss',     name: 'rss:nyt-world',            envVar: 'CONTEXT_RSS_NYT_WORLD',      defaultUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', language: 'english', credibility: 0.92, intervalMinutes: 30 },
  // Reuters public RSS dropped; replaced with AP News via RSSHub (no login required)
  { kind: 'rss',     name: 'rss:apnews-world',          envVar: 'CONTEXT_RSS_APNEWS_WORLD',   defaultUrl: 'https://rsshub.app/apnews/topics/apf-topnews',        language: 'english', credibility: 0.90, intervalMinutes: 30 },
  // ── Pune / India ─────────────────────────────────────────────────────────────
  { kind: 'rss',     name: 'rss:toi-pune',             envVar: 'CONTEXT_RSS_TOI_PUNE',       defaultUrl: 'https://www.timesofindia.com/rssfeeds/-2128936835.cms', language: 'english', credibility: 0.82, intervalMinutes: 30 },
  // ── Monsoon / India news ─────────────────────────────────────────────────────
  { kind: 'rss',     name: 'rss:ndtv-india',           envVar: 'CONTEXT_RSS_NDTV_INDIA',     defaultUrl: 'https://feeds.feedburner.com/ndtv/India',             language: 'english', credibility: 0.80, intervalMinutes: 45 },
  // ── Twitter/X search ────────────────────────────────────────────────────────
  // Requires twitter-cli installed and authenticated via browser cookies.
  // Sources degrade silently to empty if the CLI is missing or auth has lapsed.
  { kind: 'twitter', name: 'twitter:ai-tech',     query: 'AI OR "artificial intelligence" OR "machine learning" OR "open source AI" OR "AI coding"', credibility: 0.65, intervalMinutes: 60, maxTweets: 20 },
  { kind: 'twitter', name: 'twitter:spacex-ev',   query: 'SpaceX OR Tesla OR "Elon Musk" OR "electric vehicle" OR Grok', credibility: 0.65, intervalMinutes: 60, maxTweets: 20 },
  { kind: 'twitter', name: 'twitter:pune-india',  query: 'Pune OR PMC OR "Pune monsoon" OR "Pune rain"', credibility: 0.65, intervalMinutes: 45, maxTweets: 15 },
  { kind: 'twitter', name: 'twitter:geopolitics', query: 'geopolitics OR "world news" OR "global conflict"', credibility: 0.60, intervalMinutes: 90, maxTweets: 20 },
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
    } else if (def.kind === 'twitter') {
      // Allow disabling via env var (set to empty string)
      if (def.envVar !== undefined && process.env[def.envVar] === '') continue;
      sources.push(twitterSearchSource({
        name: def.name,
        query: def.query,
        intervalMinutes,
        credibility: def.credibility,
        maxTweets: def.maxTweets,
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
