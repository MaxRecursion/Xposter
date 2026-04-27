import { getBrowserContext } from './session.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';

/**
 * Reads the current authenticated user's follower handles by visiting
 * /<me>/verified_followers (and falling back to /<me>/followers).
 *
 * Returns up to `maxFollowers` of the most recent followers (X shows newest first).
 */
export async function fetchOurFollowers(meHandle: string, maxFollowers = 200): Promise<string[]> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  try {
    const candidatePaths = [
      `https://x.com/${meHandle}/verified_followers`,
      `https://x.com/${meHandle}/followers`,
    ];

    let opened = false;
    for (const url of candidatePaths) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await delay(randomBetween(2000, 3500));
        const hasUserCells = await page.locator('[data-testid="UserCell"]').count() > 0;
        if (hasUserCells) { opened = true; break; }
      } catch {
        // try next
      }
    }
    if (!opened) {
      logger.warn('Could not open followers page');
      return [];
    }

    const seen = new Set<string>();
    let stableScrolls = 0;

    while (seen.size < maxFollowers && stableScrolls < 4) {
      const newHandles: string[] = await page.evaluate(() => {
        const cells = Array.from(document.querySelectorAll('[data-testid="UserCell"]'));
        const handles: string[] = [];
        for (const cell of cells) {
          const links = cell.querySelectorAll('a[href^="/"]');
          for (const a of Array.from(links)) {
            const href = (a as HTMLAnchorElement).getAttribute('href') ?? '';
            const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
            if (m) {
              handles.push(m[1]);
              break; // one handle per cell
            }
          }
        }
        return handles;
      });

      const before = seen.size;
      for (const h of newHandles) seen.add(h);

      if (seen.size === before) {
        stableScrolls++;
      } else {
        stableScrolls = 0;
      }

      await page.evaluate(() => window.scrollBy(0, 600 + Math.floor(Math.random() * 400)));
      await delay(randomBetween(1500, 2800));
    }

    return Array.from(seen).slice(0, maxFollowers);
  } finally {
    await page.close();
  }
}

/**
 * Performs a follow-back action: navigate to the user's profile and click Follow.
 * Returns true on success.
 */
export async function followBack(handle: string): Promise<boolean> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();
  try {
    await page.goto(`https://x.com/${encodeURIComponent(handle)}`, {
      waitUntil: 'domcontentloaded', timeout: 25_000,
    });
    await delay(randomBetween(2000, 3500));

    // Try multiple selectors for the Follow button on a profile
    const followSelectors = [
      `[data-testid$="-follow"]`,
      `button[data-testid*="follow" i][data-testid$="-follow"]`,
      `[role="button"][data-testid$="-follow"]`,
    ];

    let clicked = false;
    for (const sel of followSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
        // Confirm it's actually the Follow (not "Following") variant
        const label = (await loc.getAttribute('aria-label').catch(() => null)) ?? '';
        if (/following/i.test(label)) {
          // already following
          logger.info('Already following', { handle });
          return true;
        }
        await loc.scrollIntoViewIfNeeded();
        await delay(randomBetween(400, 900));
        await loc.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      logger.warn('Follow button not found', { handle });
      return false;
    }

    await delay(randomBetween(1500, 2800));
    return true;
  } finally {
    await page.close();
  }
}
