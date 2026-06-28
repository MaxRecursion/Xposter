import Parser from 'rss-parser';
import axios from 'axios';
import type { ContextSource, ContextSourceResult } from '../types.js';
import { logger } from '../../utils/logger.js';

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
  timeout: 30_000,
  headers: {
    'User-Agent': 'Xposter-context/1.0 (+local; not for redistribution)',
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9',
  },
});

const tolerantParser = new Parser({
  timeout: 30_000,
  customFields: {},
});

export function rssSource(cfg: RssSourceConfig): ContextSource {
  const ttl = cfg.ttlSeconds ?? DEFAULT_TTL;

  return {
    name: cfg.name,
    intervalMinutes: cfg.intervalMinutes,
    async fetch(): Promise<ContextSourceResult> {
      const feed = await parseWithFallback(cfg.url, cfg.name);
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

/**
 * Many real-world feeds (Loksatta, etc.) ship malformed XML — bare ampersands,
 * unescaped angle brackets in CDATA, etc. parser.parseURL's strict mode chokes.
 * On failure we re-fetch via axios, sanity-check the content-type (sites that
 * dropped RSS often silently redirect to an HTML page), and reparse with a
 * permissive ampersand fix.
 */
async function parseWithFallback(url: string, sourceName: string): Promise<Parser.Output<Record<string, unknown>>> {
  try {
    return await parser.parseURL(url);
  } catch (firstErr) {
    if (!isXmlError(firstErr)) throw firstErr;
    logger.debug('RSS strict parse failed; trying tolerant fallback', { source: sourceName, err: String(firstErr) });

    const resp = await axios.get<string>(url, {
      timeout: 30_000,
      responseType: 'text',
      headers: {
        'User-Agent': 'Xposter-context/1.0 (+local; not for redistribution)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9',
      },
    });

    const ctype = String(resp.headers?.['content-type'] ?? '').toLowerCase();
    if (ctype.includes('text/html')) {
      throw new Error(`Endpoint returned HTML, not RSS (content-type: ${ctype}). The site may have dropped its public feed.`);
    }
    const head = resp.data.slice(0, 200).trim().toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
      throw new Error('Endpoint returned an HTML page, not RSS. The site may have dropped its public feed.');
    }

    const fixed = relaxXml(resp.data);
    return tolerantParser.parseString(fixed);
  }
}

function isXmlError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /Invalid character|Non-whitespace|Unencoded|XML|entity name|attribute name/i.test(msg);
}

/** Escape bare ampersands that aren't part of a valid entity reference. */
function relaxXml(xml: string): string {
  return xml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
}
