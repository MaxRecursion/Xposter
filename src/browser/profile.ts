import { getBrowserContext } from './session.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';
import type { Locator } from 'playwright';

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

    const displayName = await textOrNull(page.locator('[data-testid="UserName"] span').first());
    const bio = await textOrNull(page.locator('[data-testid="UserDescription"]').first());
    const verified = await page
      .locator('[data-testid="UserName"] svg[aria-label*="erified" i]')
      .count()
      .then((count) => count > 0)
      .catch(() => false);

    let followerCount = 0;
    let followingCount = 0;
    const links = page.locator('a[href$="/followers"], a[href$="/verified_followers"], a[href$="/following"]');
    const linkCount = await links.count().catch(() => 0);
    for (let i = 0; i < linkCount; i++) {
      const link = links.nth(i);
      const href = await link.getAttribute('href').catch(() => '') ?? '';
      const ariaLabel = await link.getAttribute('aria-label').catch(() => null);
      const labelText = await link.textContent().catch(() => '');
      const label = ariaLabel ?? labelText ?? '';
      const count = parseHumanCount(label);
      if (/\/(?:verified_)?followers$/i.test(href)) followerCount = Math.max(followerCount, count);
      if (/\/following$/i.test(href)) followingCount = Math.max(followingCount, count);
    }

    const pcfByTestId = await page.locator('[data-testid*="parody" i]').count().catch(() => 0);
    const pcfByText = await page.getByText(/\b(parody|fan account|commentary)\b/i).count().catch(() => 0);

    return {
      handle,
      display_name: displayName,
      bio,
      verified,
      follower_count: followerCount,
      following_count: followingCount,
      is_pcf_labelled: pcfByTestId > 0 || pcfByText > 0,
    };
  } catch (err) {
    logger.warn('Profile fetch failed', { handle, err: String(err) });
    return null;
  } finally {
    await page.close();
  }
}

async function textOrNull(locator: Locator): Promise<string | null> {
  const text = await locator.textContent({ timeout: 2_000 }).catch(() => null);
  return text?.trim() || null;
}

function parseHumanCount(input: string): number {
  const match = input.match(/([\d.,]+)\s*([KMB])?/i);
  if (!match) return 0;
  const value = parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return 0;
  const unit = (match[2] ?? '').toUpperCase();
  if (unit === 'K') return Math.round(value * 1_000);
  if (unit === 'M') return Math.round(value * 1_000_000);
  if (unit === 'B') return Math.round(value * 1_000_000_000);
  return Math.round(value);
}
