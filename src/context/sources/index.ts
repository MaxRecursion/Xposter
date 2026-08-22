import { rssSource } from './rss.js';
import { redditSource } from './reddit.js';
import { weatherSource } from './weather.js';
import { getContextIngestIntervalMin, getEnvVar } from '../../config.js';
import type { ContextSource } from '../types.js';

export type BrainCluster = 'pune-civic' | 'india-work' | 'ai-tech' | 'opt-in';

interface RssDef {
  kind: 'rss';
  name: string;
  envVar: string;
  defaultUrl: string;
  language: 'english' | 'marathi';
  credibility: number;
  intervalMinutes: number;
  cluster: BrainCluster;
  /** When false, the feed is opt-in via env (does not ingest on defaults). */
  inBrain?: boolean;
}

interface RedditDef {
  kind: 'reddit';
  name: string;
  envVar: string;
  defaultSubreddit: string;
  credibility: number;
  intervalMinutes: number;
  cluster: BrainCluster;
  inBrain?: boolean;
}

interface WeatherDef {
  kind: 'weather';
  name: string;
  envVar: string;
  defaultLocation: string;
  credibility: number;
  intervalMinutes: number;
  cluster: BrainCluster;
  inBrain?: boolean;
}

type SourceDef = RssDef | RedditDef | WeatherDef;

export interface ContextSourceCatalogRow {
  name: string;
  cluster: BrainCluster;
  inBrain: boolean;
  active: boolean;
  envVar: string;
}

/**
 * Default brain: Pune civic life + India jobs/startups/economy + AI as it
 * hits work. World geopolitics, gadgets, space, and generic tech blogs are
 * opt-in so they cannot drown the neighborhood graph.
 *
 * Empty defaultUrl/subreddit/location disables. Set the env var to a URL
 * (even for opt-in sources) to enable; set it to "" to disable a brain source.
 */
const SOURCES: SourceDef[] = [
  { kind: 'rss', name: 'rss:loksatta-pune', envVar: 'CONTEXT_RSS_LOKSATTA_PUNE', defaultUrl: '', language: 'marathi', credibility: 0.85, intervalMinutes: 30, cluster: 'pune-civic' },
  { kind: 'rss', name: 'rss:indian-express-pune', envVar: 'CONTEXT_RSS_IE_PUNE', defaultUrl: 'https://indianexpress.com/section/cities/pune/feed/', language: 'english', credibility: 0.85, intervalMinutes: 30, cluster: 'pune-civic' },
  { kind: 'rss', name: 'rss:hindustan-times-pune', envVar: 'CONTEXT_RSS_HT_PUNE', defaultUrl: 'https://www.hindustantimes.com/feeds/rss/cities/pune-news/rssfeed.xml', language: 'english', credibility: 0.82, intervalMinutes: 30, cluster: 'pune-civic' },
  { kind: 'rss', name: 'rss:toi-pune', envVar: 'CONTEXT_RSS_TOI_PUNE', defaultUrl: 'https://www.timesofindia.com/rssfeeds/-2128936835.cms', language: 'english', credibility: 0.82, intervalMinutes: 30, cluster: 'pune-civic' },
  { kind: 'rss', name: 'rss:esakal-pune', envVar: 'CONTEXT_RSS_ESAKAL_PUNE', defaultUrl: '', language: 'marathi', credibility: 0.80, intervalMinutes: 30, cluster: 'pune-civic' },
  { kind: 'reddit', name: 'reddit:pune', envVar: 'CONTEXT_REDDIT_PUNE', defaultSubreddit: 'pune', credibility: 0.65, intervalMinutes: 45, cluster: 'pune-civic' },
  { kind: 'weather', name: 'weather:pune', envVar: 'CONTEXT_WEATHER_PUNE', defaultLocation: 'Pune', credibility: 0.95, intervalMinutes: 90, cluster: 'pune-civic' },

  { kind: 'rss', name: 'rss:indian-express-jobs', envVar: 'CONTEXT_RSS_IE_JOBS', defaultUrl: 'https://indianexpress.com/section/jobs/feed/', language: 'english', credibility: 0.78, intervalMinutes: 60, cluster: 'india-work' },
  { kind: 'rss', name: 'rss:indian-express-workplace', envVar: 'CONTEXT_RSS_IE_WORKPLACE', defaultUrl: 'https://indianexpress.com/section/lifestyle/workplace/feed/', language: 'english', credibility: 0.75, intervalMinutes: 60, cluster: 'india-work' },
  { kind: 'rss', name: 'rss:indian-express-economy', envVar: 'CONTEXT_RSS_IE_ECONOMY', defaultUrl: 'https://indianexpress.com/section/business/economy/feed/', language: 'english', credibility: 0.82, intervalMinutes: 45, cluster: 'india-work' },
  { kind: 'rss', name: 'rss:rbi-press', envVar: 'CONTEXT_RSS_RBI_PRESS', defaultUrl: 'https://rbi.org.in/pressreleases_rss.xml', language: 'english', credibility: 0.98, intervalMinutes: 120, cluster: 'india-work' },
  { kind: 'rss', name: 'rss:mint-industry', envVar: 'CONTEXT_RSS_MINT_INDUSTRY', defaultUrl: 'https://www.livemint.com/rss/industry', language: 'english', credibility: 0.82, intervalMinutes: 60, cluster: 'india-work' },
  { kind: 'rss', name: 'rss:inc42', envVar: 'CONTEXT_RSS_INC42', defaultUrl: 'https://inc42.com/feed/', language: 'english', credibility: 0.78, intervalMinutes: 60, cluster: 'india-work' },
  { kind: 'rss', name: 'rss:inc42-startups', envVar: 'CONTEXT_RSS_INC42_STARTUPS', defaultUrl: 'https://inc42.com/startups/feed/', language: 'english', credibility: 0.78, intervalMinutes: 120, cluster: 'india-work' },
  { kind: 'rss', name: 'rss:yourstory', envVar: 'CONTEXT_RSS_YOURSTORY', defaultUrl: 'https://yourstory.com/feed', language: 'english', credibility: 0.74, intervalMinutes: 120, cluster: 'india-work' },
  { kind: 'rss', name: 'rss:economic-times-economy', envVar: 'CONTEXT_RSS_ET_ECONOMY', defaultUrl: 'https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms', language: 'english', credibility: 0.84, intervalMinutes: 60, cluster: 'india-work' },
  { kind: 'rss', name: 'rss:economic-times-startups', envVar: 'CONTEXT_RSS_ET_STARTUPS', defaultUrl: 'https://economictimes.indiatimes.com/small-biz/startups/rssfeeds/78570550.cms', language: 'english', credibility: 0.78, intervalMinutes: 60, cluster: 'india-work' },
  { kind: 'rss', name: 'rss:indian-express-india', envVar: 'CONTEXT_RSS_IE_INDIA', defaultUrl: 'https://indianexpress.com/section/india/feed/', language: 'english', credibility: 0.85, intervalMinutes: 45, cluster: 'india-work' },
  { kind: 'rss', name: 'rss:the-hindu-india', envVar: 'CONTEXT_RSS_HINDU_INDIA', defaultUrl: 'https://www.thehindu.com/news/national/feeder/default.rss', language: 'english', credibility: 0.90, intervalMinutes: 45, cluster: 'india-work' },
  { kind: 'rss', name: 'rss:ndtv-india', envVar: 'CONTEXT_RSS_NDTV_INDIA', defaultUrl: 'https://feeds.feedburner.com/ndtvnews-india-news', language: 'english', credibility: 0.80, intervalMinutes: 45, cluster: 'india-work' },
  { kind: 'reddit', name: 'reddit:startups', envVar: 'CONTEXT_REDDIT_STARTUPS', defaultSubreddit: 'startups', credibility: 0.55, intervalMinutes: 90, cluster: 'india-work' },

  { kind: 'rss', name: 'rss:indian-express-ai', envVar: 'CONTEXT_RSS_IE_AI', defaultUrl: 'https://indianexpress.com/section/technology/artificial-intelligence/feed/', language: 'english', credibility: 0.82, intervalMinutes: 45, cluster: 'ai-tech' },
  { kind: 'rss', name: 'rss:indian-express-tech', envVar: 'CONTEXT_RSS_IE_TECH', defaultUrl: 'https://indianexpress.com/section/technology/feed/', language: 'english', credibility: 0.82, intervalMinutes: 45, cluster: 'ai-tech' },
  { kind: 'rss', name: 'rss:mint-ai', envVar: 'CONTEXT_RSS_MINT_AI', defaultUrl: 'https://www.livemint.com/rss/AI', language: 'english', credibility: 0.82, intervalMinutes: 45, cluster: 'ai-tech' },
  { kind: 'rss', name: 'rss:mint-tech', envVar: 'CONTEXT_RSS_MINT_TECH', defaultUrl: 'https://www.livemint.com/rss/technology', language: 'english', credibility: 0.82, intervalMinutes: 60, cluster: 'ai-tech' },
  { kind: 'rss', name: 'rss:inc42-ai-shift', envVar: 'CONTEXT_RSS_INC42_AI_SHIFT', defaultUrl: 'https://inc42.com/tag/the-ai-shift/feed/', language: 'english', credibility: 0.80, intervalMinutes: 120, cluster: 'ai-tech' },
  { kind: 'rss', name: 'rss:economic-times-tech', envVar: 'CONTEXT_RSS_ET_TECH', defaultUrl: 'https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms', language: 'english', credibility: 0.82, intervalMinutes: 45, cluster: 'ai-tech' },
  { kind: 'rss', name: 'rss:techcrunch-ai', envVar: 'CONTEXT_RSS_TECHCRUNCH_AI', defaultUrl: 'https://techcrunch.com/category/artificial-intelligence/feed/', language: 'english', credibility: 0.82, intervalMinutes: 30, cluster: 'ai-tech' },
  { kind: 'rss', name: 'rss:venturebeat-ai', envVar: 'CONTEXT_RSS_VENTUREBEAT_AI', defaultUrl: 'https://venturebeat.com/category/ai/feed/', language: 'english', credibility: 0.80, intervalMinutes: 45, cluster: 'ai-tech' },
  { kind: 'rss', name: 'rss:google-ai-blog', envVar: 'CONTEXT_RSS_GOOGLE_AI', defaultUrl: 'https://blog.google/technology/ai/rss/', language: 'english', credibility: 0.88, intervalMinutes: 120, cluster: 'ai-tech' },
  { kind: 'rss', name: 'rss:deepmind', envVar: 'CONTEXT_RSS_DEEPMIND', defaultUrl: 'https://deepmind.google/blog/rss.xml', language: 'english', credibility: 0.88, intervalMinutes: 120, cluster: 'ai-tech' },
  { kind: 'rss', name: 'rss:semianalysis', envVar: 'CONTEXT_RSS_SEMIANALYSIS', defaultUrl: 'https://www.semianalysis.com/feed', language: 'english', credibility: 0.86, intervalMinutes: 120, cluster: 'ai-tech' },
  { kind: 'rss', name: 'rss:mit-tech-review', envVar: 'CONTEXT_RSS_MIT_TECH_REVIEW', defaultUrl: 'https://www.technologyreview.com/feed/', language: 'english', credibility: 0.85, intervalMinutes: 120, cluster: 'ai-tech' },
  { kind: 'rss', name: 'rss:bbc-tech', envVar: 'CONTEXT_RSS_BBC_TECH', defaultUrl: 'https://feeds.bbci.co.uk/news/technology/rss.xml', language: 'english', credibility: 0.85, intervalMinutes: 60, cluster: 'ai-tech' },

  // Opt-in: related enough to keep wired, but they dilute the Pune/work graph.
  { kind: 'rss', name: 'rss:techcrunch', envVar: 'CONTEXT_RSS_TECHCRUNCH', defaultUrl: 'https://techcrunch.com/feed/', language: 'english', credibility: 0.82, intervalMinutes: 30, cluster: 'opt-in', inBrain: false },
  { kind: 'rss', name: 'rss:wired', envVar: 'CONTEXT_RSS_WIRED', defaultUrl: 'https://www.wired.com/feed/rss', language: 'english', credibility: 0.82, intervalMinutes: 60, cluster: 'opt-in', inBrain: false },
  { kind: 'rss', name: 'rss:arstechnica', envVar: 'CONTEXT_RSS_ARSTECHNICA', defaultUrl: 'https://feeds.arstechnica.com/arstechnica/index', language: 'english', credibility: 0.83, intervalMinutes: 60, cluster: 'opt-in', inBrain: false },
  { kind: 'rss', name: 'rss:theverge', envVar: 'CONTEXT_RSS_THEVERGE', defaultUrl: 'https://www.theverge.com/rss/index.xml', language: 'english', credibility: 0.80, intervalMinutes: 45, cluster: 'opt-in', inBrain: false },
  { kind: 'rss', name: 'rss:hackernews', envVar: 'CONTEXT_RSS_HACKERNEWS', defaultUrl: 'https://hnrss.org/frontpage', language: 'english', credibility: 0.78, intervalMinutes: 30, cluster: 'opt-in', inBrain: false },
  { kind: 'rss', name: 'rss:github-blog', envVar: 'CONTEXT_RSS_GITHUB_BLOG', defaultUrl: 'https://github.blog/feed/', language: 'english', credibility: 0.85, intervalMinutes: 120, cluster: 'opt-in', inBrain: false },
  { kind: 'rss', name: 'rss:electrek', envVar: 'CONTEXT_RSS_ELECTREK', defaultUrl: 'https://electrek.co/feed/', language: 'english', credibility: 0.80, intervalMinutes: 45, cluster: 'opt-in', inBrain: false },
  { kind: 'rss', name: 'rss:teslarati', envVar: 'CONTEXT_RSS_TESLARATI', defaultUrl: 'https://www.teslarati.com/feed/', language: 'english', credibility: 0.75, intervalMinutes: 60, cluster: 'opt-in', inBrain: false },
  { kind: 'rss', name: 'rss:spacenews', envVar: 'CONTEXT_RSS_SPACENEWS', defaultUrl: 'https://spacenews.com/feed/', language: 'english', credibility: 0.85, intervalMinutes: 60, cluster: 'opt-in', inBrain: false },
  { kind: 'rss', name: 'rss:gsmarena', envVar: 'CONTEXT_RSS_GSMARENA', defaultUrl: 'https://www.gsmarena.com/rss-news-reviews.php3', language: 'english', credibility: 0.78, intervalMinutes: 60, cluster: 'opt-in', inBrain: false },
  { kind: 'rss', name: 'rss:9to5mac', envVar: 'CONTEXT_RSS_9TO5MAC', defaultUrl: 'https://9to5mac.com/feed/', language: 'english', credibility: 0.78, intervalMinutes: 60, cluster: 'opt-in', inBrain: false },
  { kind: 'rss', name: 'rss:bbc-world', envVar: 'CONTEXT_RSS_BBC_WORLD', defaultUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml', language: 'english', credibility: 0.90, intervalMinutes: 30, cluster: 'opt-in', inBrain: false },
  { kind: 'rss', name: 'rss:nyt-world', envVar: 'CONTEXT_RSS_NYT_WORLD', defaultUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', language: 'english', credibility: 0.92, intervalMinutes: 30, cluster: 'opt-in', inBrain: false },
  { kind: 'rss', name: 'rss:guardian-world', envVar: 'CONTEXT_RSS_GUARDIAN_WORLD', defaultUrl: 'https://www.theguardian.com/world/rss', language: 'english', credibility: 0.90, intervalMinutes: 45, cluster: 'opt-in', inBrain: false },
  { kind: 'rss', name: 'rss:aljazeera', envVar: 'CONTEXT_RSS_ALJAZEERA', defaultUrl: 'https://www.aljazeera.com/xml/rss/all.xml', language: 'english', credibility: 0.85, intervalMinutes: 60, cluster: 'opt-in', inBrain: false },
  { kind: 'rss', name: 'rss:espncricinfo', envVar: 'CONTEXT_RSS_ESPNCRICINFO', defaultUrl: 'https://www.espncricinfo.com/rss/content/story/feeds/0.xml', language: 'english', credibility: 0.82, intervalMinutes: 60, cluster: 'opt-in', inBrain: false },
  { kind: 'reddit', name: 'reddit:india', envVar: 'CONTEXT_REDDIT_INDIA', defaultSubreddit: 'india', credibility: 0.55, intervalMinutes: 60, cluster: 'opt-in', inBrain: false },
];

function inBrain(def: SourceDef): boolean {
  return def.inBrain !== false;
}

function resolveEndpoint(def: SourceDef): string {
  const env = getEnvVar(def.envVar);
  if (env !== undefined) return env;
  if (!inBrain(def)) return '';
  if (def.kind === 'rss') return def.defaultUrl;
  if (def.kind === 'reddit') return def.defaultSubreddit;
  return def.defaultLocation;
}

export function listContextSourceCatalog(): ContextSourceCatalogRow[] {
  return SOURCES.map((def) => {
    const endpoint = resolveEndpoint(def);
    return {
      name: def.name,
      cluster: def.cluster,
      inBrain: inBrain(def),
      active: endpoint.length > 0,
      envVar: def.envVar,
    };
  });
}

export function buildContextSources(): ContextSource[] {
  const overrideMin = getContextIngestIntervalMin();
  const sources: ContextSource[] = [];

  for (const def of SOURCES) {
    const intervalMinutes = overrideMin ?? def.intervalMinutes;
    const endpoint = resolveEndpoint(def);
    if (!endpoint) continue;

    if (def.kind === 'rss') {
      sources.push(withCluster(rssSource({
        name: def.name,
        url: endpoint,
        intervalMinutes,
        language: def.language,
        credibility: def.credibility,
      }), def.cluster));
    } else if (def.kind === 'reddit') {
      sources.push(withCluster(redditSource({
        name: def.name,
        subreddit: endpoint,
        intervalMinutes,
        credibility: def.credibility,
      }), def.cluster));
    } else {
      sources.push(withCluster(weatherSource({
        name: def.name,
        location: endpoint,
        intervalMinutes,
        credibility: def.credibility,
      }), def.cluster));
    }
  }

  return sources;
}

function withCluster(source: ContextSource, cluster: BrainCluster): ContextSource {
  return { ...source, cluster };
}
