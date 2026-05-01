import Parser from 'rss-parser';
import type { ContextSource, ContextSourceResult } from '../types.js';

export interface RssSourceConfig {
  name: string;
  url: string;
  intervalMinutes: number;
  language: string | null;
  credibility: number;
  /** TTL for stored items in seconds. Defaults to 7 days. */
  ttlSeconds?: number;
}

const DEFAULT_TTL = 7 * 24 * 3600;

const parser = new Parser({
  timeout: 15_000,
  headers: {
    'User-Agent': 'Xposter-context/1.0 (+local; not for redistribution)',
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9',
  },
});

export function rssSource(cfg: RssSourceConfig): ContextSource {
  const ttl = cfg.ttlSeconds ?? DEFAULT_TTL;

  return {
    name: cfg.name,
    intervalMinutes: cfg.intervalMinutes,
    async fetch(): Promise<ContextSourceResult> {
      const feed = await parser.parseURL(cfg.url);
      const items = (feed.items ?? []).flatMap((it) => {
        const rawBody = (it.contentSnippet ?? it.content ?? it.summary ?? '').trim();
        const title = (it.title ?? '').trim();
        const body = rawBody || title;
        if (!body) return [];

        const publishedAt =
          it.isoDate ? Math.floor(new Date(it.isoDate).getTime() / 1000)
          : it.pubDate ? Math.floor(new Date(it.pubDate).getTime() / 1000)
          : null;
        const expiresAt = publishedAt != null ? publishedAt + ttl : Math.floor(Date.now() / 1000) + ttl;

        return [{
          source: cfg.name,
          sourceUrl: it.link ?? null,
          title: title || null,
          body,
          language: cfg.language,
          publishedAt,
          expiresAt,
          credibility: cfg.credibility,
        }];
      });
      return { source: cfg.name, items };
    },
  };
}
