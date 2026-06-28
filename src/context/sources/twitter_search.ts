import { execFileSync } from 'child_process';
import type { ContextSource, ContextSourceResult } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface TwitterSearchSourceConfig {
  name: string;
  query: string;
  intervalMinutes: number;
  credibility: number;
  /** Max tweets to fetch per poll. Defaults to 20. */
  maxTweets?: number;
  /** TTL for stored items in seconds. Defaults to 6 hours. */
  ttlSeconds?: number;
}

const DEFAULT_TTL = 6 * 3600;

// twitter-cli installs into the user Python bin; check both pipx and pip paths.
const TWITTER_BIN_CANDIDATES = [
  '/Users/akshaykulkarni/.local/bin/twitter',
  '/Users/akshaykulkarni/Library/Python/3.9/bin/twitter',
  '/Users/akshaykulkarni/Library/Python/3.10/bin/twitter',
  '/Users/akshaykulkarni/Library/Python/3.11/bin/twitter',
  '/usr/local/bin/twitter',
];

function findTwitterBin(): string | null {
  for (const candidate of TWITTER_BIN_CANDIDATES) {
    try {
      execFileSync(candidate, ['--version'], { timeout: 5_000, stdio: 'pipe' });
      return candidate;
    } catch {
      // not found or not working
    }
  }
  return null;
}

interface TweetJson {
  id?: string;
  text?: string;
  full_text?: string;
  created_at?: string;
  user?: { screen_name?: string };
  url?: string;
}

function parseTweets(raw: string): TweetJson[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    // twitter-cli --json returns either an array or { tweets: [...] }
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.tweets)) return parsed.tweets;
    if (Array.isArray(parsed?.data)) return parsed.data;
    return [];
  } catch {
    return [];
  }
}

function tweetToUrl(tweet: TweetJson): string | null {
  if (tweet.url) return tweet.url;
  const id = tweet.id;
  const handle = tweet.user?.screen_name;
  if (id && handle) return `https://x.com/${handle}/status/${id}`;
  if (id) return `https://x.com/i/web/status/${id}`;
  return null;
}

export function twitterSearchSource(cfg: TwitterSearchSourceConfig): ContextSource {
  const ttl = cfg.ttlSeconds ?? DEFAULT_TTL;
  const maxTweets = cfg.maxTweets ?? 20;
  let binPath: string | null | undefined; // undefined = not yet checked

  return {
    name: cfg.name,
    intervalMinutes: cfg.intervalMinutes,
    async fetch(): Promise<ContextSourceResult> {
      // Lazy-resolve binary once
      if (binPath === undefined) {
        binPath = findTwitterBin();
        if (!binPath) {
          logger.warn('twitter-cli not found; skipping Twitter source', { source: cfg.name });
        }
      }

      if (!binPath) return { source: cfg.name, items: [] };

      let stdout: string;
      try {
        const buf = execFileSync(
          binPath,
          ['search', cfg.query, '--json', '--max', String(maxTweets)],
          {
            timeout: 30_000,
            maxBuffer: 5 * 1024 * 1024,
            // Don't inherit env vars that might confuse the binary
            env: { ...process.env, TERM: 'dumb' },
          },
        );
        stdout = buf.toString('utf8');
      } catch (err) {
        const msg = String((err as NodeJS.ErrnoException)?.message ?? err);
        // Auth errors are expected if cookies are stale — downgrade to warn
        const isAuthErr = /401|403|authenticate|cookie|auth/i.test(msg);
        if (isAuthErr) {
          logger.warn('twitter-cli auth error; skipping this poll', { source: cfg.name, err: msg.slice(0, 200) });
        } else {
          logger.error('twitter-cli search failed', { source: cfg.name, err: msg.slice(0, 400) });
        }
        return { source: cfg.name, items: [] };
      }

      const tweets = parseTweets(stdout);
      const now = Math.floor(Date.now() / 1000);

      const items = tweets.flatMap((t) => {
        const text = (t.full_text ?? t.text ?? '').trim();
        if (!text) return [];

        const publishedAt = t.created_at ? Math.floor(new Date(t.created_at).getTime() / 1000) : null;

        return [{
          source: cfg.name,
          sourceUrl: tweetToUrl(t),
          title: text.slice(0, 120) + (text.length > 120 ? '…' : ''),
          body: text,
          language: 'english' as const,
          publishedAt,
          expiresAt: (publishedAt ?? now) + ttl,
          credibility: cfg.credibility,
        }];
      });

      logger.info('twitter search fetched', { source: cfg.name, count: items.length, query: cfg.query });
      return { source: cfg.name, items };
    },
  };
}
