import axios from 'axios';
import type { ContextSource, ContextSourceResult } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface JinaSourceConfig {
  name: string;
  /** List of URLs to fetch via Jina Reader. */
  urls: string[];
  intervalMinutes: number;
  credibility: number;
  /** TTL for stored items in seconds. Defaults to 24 hours. */
  ttlSeconds?: number;
}

const DEFAULT_TTL = 24 * 3600;
const JINA_BASE = 'https://r.jina.ai/';

export function jinaSource(cfg: JinaSourceConfig): ContextSource {
  const ttl = cfg.ttlSeconds ?? DEFAULT_TTL;

  return {
    name: cfg.name,
    intervalMinutes: cfg.intervalMinutes,
    async fetch(): Promise<ContextSourceResult> {
      const now = Math.floor(Date.now() / 1000);
      const items = (
        await Promise.all(
          cfg.urls.map(async (url) => {
            try {
              const resp = await axios.get<string>(`${JINA_BASE}${url}`, {
                timeout: 20_000,
                responseType: 'text',
                headers: {
                  'User-Agent': 'Xposter-context/1.0 (single-user)',
                  Accept: 'text/plain, text/markdown',
                  // Return plain markdown without embedded images
                  'X-Return-Format': 'markdown',
                },
              });

              const raw = resp.data ?? '';
              // First non-empty line is typically the title
              const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
              if (!lines.length) return null;

              const title = lines[0].replace(/^#+\s*/, '').slice(0, 200) || null;
              // Use first ~2000 chars as body to stay within context budget
              const body = raw.slice(0, 2000).trim();
              if (!body) return null;

              return {
                source: cfg.name,
                sourceUrl: url,
                title,
                body,
                language: 'english' as const,
                publishedAt: null,
                expiresAt: now + ttl,
                credibility: cfg.credibility,
              };
            } catch (err) {
              logger.warn('Jina Reader fetch failed', { source: cfg.name, url, err: String(err) });
              return null;
            }
          }),
        )
      ).filter((x): x is NonNullable<typeof x> => x !== null);

      return { source: cfg.name, items };
    },
  };
}
