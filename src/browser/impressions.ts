import { getBrowserContext, runExclusive } from './session.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';

export interface EngagementData {
  impressions: number;
  likes: number;
  replies: number;
  retweets: number;
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
export async function scrapeEngagement(tweetUrl: string): Promise<EngagementData> {
  return runExclusive(() => scrapeEngagementImpl(tweetUrl));
}

async function scrapeEngagementImpl(tweetUrl: string): Promise<EngagementData> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  try {
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await delay(randomBetween(2000, 3500));

    try {
      await page.waitForSelector('[data-testid="primaryColumn"]', { timeout: 12_000 });
    } catch {
      logger.warn('primaryColumn not found for engagement scrape', { tweetUrl });
    }

    const data = await page.evaluate(() => {
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
        // The count lives in the last non-empty span inside the group
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

      // Impressions: X shows "X views" as text in the tweet analytics section.
      // The "views" counter lives below the action bar, often inside an analytics link.
      let impressions = 0;
      const viewsAnchor = document.querySelector('a[href*="/analytics"]');
      if (viewsAnchor) {
        impressions = parseCount(viewsAnchor.textContent ?? null);
      }
      if (impressions === 0) {
        // Fallback: look for any span whose aria-label contains "view"
        const viewSpans = Array.from(document.querySelectorAll('span[aria-label*="view" i]'));
        for (const s of viewSpans) {
          const n = parseCount(s.getAttribute('aria-label') ?? s.textContent ?? null);
          if (n > 0) { impressions = n; break; }
        }
      }

      return { impressions, likes, replies, retweets };
    });

    return data;
  } catch (err) {
    logger.warn('Engagement scrape failed', { tweetUrl, err: String(err) });
    return { impressions: 0, likes: 0, replies: 0, retweets: 0 };
  } finally {
    await page.close();
  }
}
