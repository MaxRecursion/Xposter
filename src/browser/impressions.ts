import { getBrowserContext, runExclusive } from './session.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';

export interface EngagementData {
  impressions: number;
  likes: number;
  replies: number;
  retweets: number;
  authorEngaged: boolean;
}

export interface ScrapeEngagementOptions {
  /** Parent tweet author — used to detect whether they replied to us. */
  parentAuthorHandle?: string | null;
}

/**
 * True when a later conversation article is authored by `parentHandle`.
 * The permalink tweet is index 0; replies sit after it. False-negatives preferred.
 */
export function authorAppearsInLaterArticles(
  articles: Array<{ authorHandles: string[] }>,
  parentHandle: string,
): boolean {
  const needle = parentHandle.replace(/^@/, '').trim().toLowerCase();
  if (!needle || articles.length < 2) return false;
  return articles.slice(1).some((article) =>
    article.authorHandles.some((h) => h.replace(/^@/, '').trim().toLowerCase() === needle),
  );
}

/**
 * Navigates to a tweet URL and scrapes its current engagement counts.
 *
 * Impressions (views) are shown by X as plain text below the tweet buttons since 2022.
 * Likes/replies/retweets are scraped from their aria-label aria-labels.
 *
 * All functions inside page.evaluate() use arrow-function syntax to avoid the
 * tsx/esbuild __name injection that would break in browser context.
 */
export async function scrapeEngagement(
  tweetUrl: string,
  opts: ScrapeEngagementOptions = {},
): Promise<EngagementData> {
  return runExclusive(() => scrapeEngagementImpl(tweetUrl, opts.parentAuthorHandle ?? null));
}

async function scrapeEngagementImpl(
  tweetUrl: string,
  parentAuthorHandle: string | null,
): Promise<EngagementData> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();
  const empty: EngagementData = {
    impressions: 0, likes: 0, replies: 0, retweets: 0, authorEngaged: false,
  };

  try {
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await delay(randomBetween(2000, 3500));

    try {
      await page.waitForSelector('[data-testid="primaryColumn"]', { timeout: 12_000 });
    } catch {
      logger.warn('primaryColumn not found for engagement scrape', { tweetUrl });
    }

    const data = await page.evaluate((parentHandle: string | null) => {
      const parseCount = (text: string | null): number => {
        if (!text) return 0;
        const m = text.match(/([\d.,]+)\s*([KMB])?/i);
        if (!m) return 0;
        const n = parseFloat(m[1].replace(/,/g, ''));
        if (!isFinite(n)) return 0;
        const unit = (m[2] ?? '').toUpperCase();
        if (unit === 'K') return Math.round(n * 1_000);
        if (unit === 'M') return Math.round(n * 1_000_000);
        if (unit === 'B') return Math.round(n * 1_000_000_000);
        return Math.round(n);
      };

      const getGroupCount = (testId: string): number => {
        const group = document.querySelector(`[data-testid="${testId}"]`);
        if (!group) return 0;
        const spans = Array.from(group.querySelectorAll('span'));
        for (const s of [...spans].reverse()) {
          const n = parseCount(s.textContent ?? null);
          if (n > 0) return n;
        }
        return 0;
      };

      const likes = getGroupCount('like');
      const replies = getGroupCount('reply');
      const retweets = getGroupCount('retweet');

      let impressions = 0;
      const viewsAnchor = document.querySelector('a[href*="/analytics"]');
      if (viewsAnchor) {
        impressions = parseCount(viewsAnchor.textContent ?? null);
      }
      if (impressions === 0) {
        const viewSpans = Array.from(document.querySelectorAll('span[aria-label*="view" i]'));
        for (const s of viewSpans) {
          const n = parseCount(s.getAttribute('aria-label') ?? s.textContent ?? null);
          if (n > 0) { impressions = n; break; }
        }
      }

      let authorEngaged = false;
      const needle = (parentHandle ?? '').replace(/^@/, '').trim().toLowerCase();
      if (needle) {
        const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
        for (let i = 1; i < tweets.length; i++) {
          const links = Array.from(tweets[i].querySelectorAll('a[href^="/"]'));
          for (const a of links) {
            const href = (a.getAttribute('href') ?? '').split('?')[0];
            const parts = href.split('/').filter(Boolean);
            if (parts.length === 1 && parts[0].toLowerCase() === needle) {
              authorEngaged = true;
              break;
            }
          }
          if (authorEngaged) break;
        }
      }

      return { impressions, likes, replies, retweets, authorEngaged };
    }, parentAuthorHandle);

    return data;
  } catch (err) {
    logger.warn('Engagement scrape failed', { tweetUrl, err: String(err) });
    return empty;
  } finally {
    await page.close();
  }
}
