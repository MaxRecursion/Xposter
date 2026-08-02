import { rssSource } from './rss.js';
import { redditSource } from './reddit.js';
import { weatherSource } from './weather.js';
import { getContextIngestIntervalMin, getEnvVar } from '../../config.js';
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
  // AP News RSSHub mirror started returning 403; Guardian + Al Jazeera are direct.
  { kind: 'rss',     name: 'rss:guardian-world',       envVar: 'CONTEXT_RSS_GUARDIAN_WORLD', defaultUrl: 'https://www.theguardian.com/world/rss',               language: 'english', credibility: 0.90, intervalMinutes: 45 },
  { kind: 'rss',     name: 'rss:aljazeera',            envVar: 'CONTEXT_RSS_ALJAZEERA',      defaultUrl: 'https://www.aljazeera.com/xml/rss/all.xml',           language: 'english', credibility: 0.85, intervalMinutes: 60 },
  // ── Pune / India ─────────────────────────────────────────────────────────────
  { kind: 'rss',     name: 'rss:toi-pune',             envVar: 'CONTEXT_RSS_TOI_PUNE',       defaultUrl: 'https://www.timesofindia.com/rssfeeds/-2128936835.cms', language: 'english', credibility: 0.82, intervalMinutes: 30 },
  { kind: 'rss',     name: 'rss:indian-express-india', envVar: 'CONTEXT_RSS_IE_INDIA',     defaultUrl: 'https://indianexpress.com/section/india/feed/',       language: 'english', credibility: 0.85, intervalMinutes: 45 },
  { kind: 'rss',     name: 'rss:the-hindu-india',      envVar: 'CONTEXT_RSS_HINDU_INDIA',  defaultUrl: 'https://www.thehindu.com/news/national/feeder/default.rss', language: 'english', credibility: 0.90, intervalMinutes: 45 },
  // ── India tech / economy ─────────────────────────────────────────────────────
  { kind: 'rss',     name: 'rss:indian-express-tech',  envVar: 'CONTEXT_RSS_IE_TECH',      defaultUrl: 'https://indianexpress.com/section/technology/feed/',  language: 'english', credibility: 0.82, intervalMinutes: 45 },
  { kind: 'rss',     name: 'rss:economic-times-tech',  envVar: 'CONTEXT_RSS_ET_TECH',      defaultUrl: 'https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms', language: 'english', credibility: 0.82, intervalMinutes: 45 },
  { kind: 'rss',     name: 'rss:economic-times-economy', envVar: 'CONTEXT_RSS_ET_ECONOMY', defaultUrl: 'https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms', language: 'english', credibility: 0.84, intervalMinutes: 60 },
  { kind: 'rss',     name: 'rss:economic-times-startups', envVar: 'CONTEXT_RSS_ET_STARTUPS', defaultUrl: 'https://economictimes.indiatimes.com/small-biz/startups/rssfeeds/78570550.cms', language: 'english', credibility: 0.78, intervalMinutes: 60 },
  { kind: 'rss',     name: 'rss:mint-tech',            envVar: 'CONTEXT_RSS_MINT_TECH',    defaultUrl: 'https://www.livemint.com/rss/technology',             language: 'english', credibility: 0.82, intervalMinutes: 60 },
  // ── AI research / analysis ───────────────────────────────────────────────────
  { kind: 'rss',     name: 'rss:google-ai-blog',       envVar: 'CONTEXT_RSS_GOOGLE_AI',    defaultUrl: 'https://blog.google/technology/ai/rss/',              language: 'english', credibility: 0.88, intervalMinutes: 120 },
  { kind: 'rss',     name: 'rss:deepmind',             envVar: 'CONTEXT_RSS_DEEPMIND',    defaultUrl: 'https://deepmind.google/blog/rss.xml',                language: 'english', credibility: 0.88, intervalMinutes: 120 },
  { kind: 'rss',     name: 'rss:semianalysis',         envVar: 'CONTEXT_RSS_SEMIANALYSIS', defaultUrl: 'https://www.semianalysis.com/feed',                   language: 'english', credibility: 0.86, intervalMinutes: 120 },
  { kind: 'rss',     name: 'rss:mit-tech-review',      envVar: 'CONTEXT_RSS_MIT_TECH_REVIEW', defaultUrl: 'https://www.technologyreview.com/feed/',           language: 'english', credibility: 0.85, intervalMinutes: 120 },
  { kind: 'rss',     name: 'rss:bbc-tech',             envVar: 'CONTEXT_RSS_BBC_TECH',     defaultUrl: 'https://feeds.bbci.co.uk/news/technology/rss.xml',    language: 'english', credibility: 0.85, intervalMinutes: 60 },
  // ── Monsoon / India news ─────────────────────────────────────────────────────
  // feedburner.com/ndtv/India now returns HTML; ndtvnews-india-news still works.
  { kind: 'rss',     name: 'rss:ndtv-india',           envVar: 'CONTEXT_RSS_NDTV_INDIA',     defaultUrl: 'https://feeds.feedburner.com/ndtvnews-india-news',   language: 'english', credibility: 0.80, intervalMinutes: 45 },
  // ── Sports ───────────────────────────────────────────────────────────────────
  { kind: 'rss',     name: 'rss:espncricinfo',         envVar: 'CONTEXT_RSS_ESPNCRICINFO',   defaultUrl: 'https://www.espncricinfo.com/rss/content/story/feeds/0.xml', language: 'english', credibility: 0.82, intervalMinutes: 60 },
  // Live X search is not a context source: it runs through the Playwright
  // session (searchTweets in src/browser/ingestion.ts), driven by trend_source.
  { kind: 'reddit',  name: 'reddit:pune',             envVar: 'CONTEXT_REDDIT_PUNE',       defaultSubreddit: 'pune',                                          credibility: 0.65, intervalMinutes: 45 },
  { kind: 'reddit',  name: 'reddit:india',            envVar: 'CONTEXT_REDDIT_INDIA',      defaultSubreddit: 'india',                                         credibility: 0.55, intervalMinutes: 60 },
  { kind: 'reddit',  name: 'reddit:startups',         envVar: 'CONTEXT_REDDIT_STARTUPS',   defaultSubreddit: 'startups',                                      credibility: 0.55, intervalMinutes: 90 },
  { kind: 'weather', name: 'weather:pune',            envVar: 'CONTEXT_WEATHER_PUNE',      defaultLocation: 'Pune',                                           credibility: 0.95, intervalMinutes: 90 },
];

export function buildContextSources(): ContextSource[] {
  const overrideMin = getContextIngestIntervalMin();
  const sources: ContextSource[] = [];

  for (const def of SOURCES) {
    const intervalMinutes = overrideMin ?? def.intervalMinutes;

    if (def.kind === 'rss') {
      const url = getEnvVar(def.envVar) ?? def.defaultUrl;
      if (!url || url.trim() === '') continue;
      sources.push(rssSource({
        name: def.name,
        url,
        intervalMinutes,
        language: def.language,
        credibility: def.credibility,
      }));
    } else if (def.kind === 'reddit') {
      const sub = getEnvVar(def.envVar) ?? def.defaultSubreddit;
      if (!sub || sub.trim() === '') continue;
      sources.push(redditSource({
        name: def.name,
        subreddit: sub,
        intervalMinutes,
        credibility: def.credibility,
      }));
    } else {
      const loc = getEnvVar(def.envVar) ?? def.defaultLocation;
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
