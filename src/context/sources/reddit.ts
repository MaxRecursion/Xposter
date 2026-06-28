import axios from 'axios';
import type { ContextSource, ContextSourceResult } from '../types.js';

export interface RedditSourceConfig {
  name: string;
  subreddit: string;            // 'pune', 'india'
  intervalMinutes: number;
  credibility: number;
  /** Pull 'hot', 'new', or 'top'. Default 'hot'. */
  listing?: 'hot' | 'new' | 'top';
  /** Number of posts to pull, max 100. Default 25. */
  limit?: number;
  /** TTL for stored items in seconds. Defaults to 3 days. */
  ttlSeconds?: number;
}

interface RedditChild {
  data: {
    title: string;
    selftext: string;
    permalink: string;
    created_utc: number;
    score: number;
    num_comments: number;
    subreddit: string;
    over_18: boolean;
    stickied: boolean;
    is_self: boolean;
  };
}

const DEFAULT_TTL = 3 * 24 * 3600;
const ENDPOINT = (sub: string, listing: string, limit: number) =>
  `https://www.reddit.com/r/${encodeURIComponent(sub)}/${listing}.json?limit=${limit}`;

export function redditSource(cfg: RedditSourceConfig): ContextSource {
  const ttl = cfg.ttlSeconds ?? DEFAULT_TTL;
  const listing = cfg.listing ?? 'hot';
  const limit = Math.min(100, Math.max(1, cfg.limit ?? 25));

  return {
    name: cfg.name,
    intervalMinutes: cfg.intervalMinutes,
    async fetch(): Promise<ContextSourceResult> {
      const resp = await axios.get<{ data: { children: RedditChild[] } }>(
        ENDPOINT(cfg.subreddit, listing, limit),
        {
          timeout: 30_000,
          headers: {
            'User-Agent': 'Xposter-context/1.0 (single-user, non-commercial)',
            Accept: 'application/json',
          },
          // Reddit responds 403 to some default agents; explicit accept-encoding helps too
          decompress: true,
        },
      );

      const children = resp.data?.data?.children ?? [];
      const items = children.flatMap((c) => {
        const d = c.data;
        if (d.over_18 || d.stickied) return [];

        // Body must be stable across fetches so SHA-256 hash dedup works. We
        // intentionally exclude live counters (score, num_comments) — they
        // change every poll and would defeat dedup.
        const body = d.is_self
          ? (d.selftext?.trim() || d.title.trim())
          : d.title.trim();
        if (!body) return [];

        const publishedAt = Math.floor(d.created_utc);
        return [{
          source: cfg.name,
          sourceUrl: `https://www.reddit.com${d.permalink}`,
          title: d.title,
          body,
          language: 'english' as const,
          publishedAt,
          expiresAt: publishedAt + ttl,
          credibility: cfg.credibility,
        }];
      });

      return { source: cfg.name, items };
    },
  };
}
