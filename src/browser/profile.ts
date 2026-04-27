import { getBrowserContext } from './session.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';

export interface AuthorProfile {
  handle: string;
  display_name: string | null;
  bio: string | null;
  verified: boolean;
  follower_count: number;
  following_count: number;
  is_pcf_labelled: boolean;   // X's official Parody/Commentary/Fan label visible
}

/**
 * Fetches an author's profile page and extracts bio + counts.
 * Best-effort: falls back to nulls/zeros if the DOM doesn't yield.
 *
 * Uses the Playwright persistent context (same logged-in session as
 * ingestion/posting). Profile is opened in a new tab and closed immediately.
 */
export async function fetchProfile(handle: string): Promise<AuthorProfile | null> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  const url = `https://x.com/${encodeURIComponent(handle)}`;
  try {
    logger.info('Fetching profile', { handle });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await delay(randomBetween(1500, 2800));

    // Wait for primary column
    try {
      await page.waitForSelector('[data-testid="primaryColumn"]', { timeout: 12_000 });
    } catch {
      logger.warn('Profile page did not render primaryColumn', { handle });
    }

    const data = await page.evaluate(() => {
      const txt = (sel: string): string | null => {
        const el = document.querySelector(sel);
        return el?.textContent?.trim() ?? null;
      };

      const display_name = txt('[data-testid="UserName"] span') ?? null;
      const bio = txt('[data-testid="UserDescription"]') ?? null;

      // Verified: blue check icon present
      const verified = !!document.querySelector('[data-testid="UserName"] svg[aria-label*="erified" i]');

      // Counts: aria-labels on the followers/following links contain the numbers
      let follower_count = 0;
      let following_count = 0;
      const links = Array.from(document.querySelectorAll('a[href$="/followers"], a[href$="/verified_followers"], a[href$="/following"]'));

      const parseHumanCount = (input: string): number => {
        const m = input.match(/([\d.,]+)\s*([KMB])?/i);
        if (!m) return 0;
        const n = parseFloat(m[1].replace(/,/g, ''));
        if (!isFinite(n)) return 0;
        const unit = (m[2] ?? '').toUpperCase();
        if (unit === 'K') return Math.round(n * 1_000);
        if (unit === 'M') return Math.round(n * 1_000_000);
        if (unit === 'B') return Math.round(n * 1_000_000_000);
        return Math.round(n);
      };

      for (const a of links) {
        const href = (a as HTMLAnchorElement).href;
        const label = a.getAttribute('aria-label') ?? a.textContent ?? '';
        const num = parseHumanCount(label);
        if (/follower/i.test(href)) follower_count = Math.max(follower_count, num);
        if (/following$/i.test(href)) following_count = Math.max(following_count, num);
      }

      // X's official PCF label appears as a chip near the username
      const is_pcf_labelled =
        !!document.querySelector('[data-testid*="parody" i]') ||
        Array.from(document.querySelectorAll('span')).some((s) =>
          /\b(parody|fan account|commentary)\b/i.test(s.textContent ?? '')
        );

      return { display_name, bio, verified, follower_count, following_count, is_pcf_labelled };
    });

    return { handle, ...data };
  } catch (err) {
    logger.warn('Profile fetch failed', { handle, err: String(err) });
    return null;
  } finally {
    await page.close();
  }
}
