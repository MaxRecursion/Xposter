import { getBrowserContext, runExclusive } from './session.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';
import { getXHandle } from '../config.js';

export interface FollowerListEntry {
  handle: string;
  followedByUs: boolean | null;
}

export async function resolveOwnHandle(): Promise<string | null> {
  return runExclusive(() => resolveOwnHandleImpl());
}

async function resolveOwnHandleImpl(): Promise<string | null> {
  const configured = sanitizeHandle(getXHandle() ?? '');
  if (configured) return configured;

  const ctx = await getBrowserContext();
  const page = await ctx.newPage();
  try {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await delay(randomBetween(1500, 2500));

    const handle = await page.evaluate(() => {
      const profileHref = document
        .querySelector<HTMLAnchorElement>('a[data-testid="AppTabBar_Profile_Link"], a[aria-label="Profile"]')
        ?.getAttribute('href');
      if (profileHref && /^\/[A-Za-z0-9_]{1,15}$/.test(profileHref)) {
        return profileHref.slice(1);
      }

      const hrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'))
        .map((a) => a.getAttribute('href') ?? '');
      const fallbackHref = hrefs.find((href) => /^\/[A-Za-z0-9_]{1,15}$/.test(href) &&
        !['/home', '/explore', '/notifications', '/messages', '/i'].includes(href));
      return fallbackHref?.slice(1) ?? null;
    });

    return sanitizeHandle(handle ?? '');
  } catch (err) {
    logger.warn('Could not auto-detect X handle', { err: String(err) });
    return null;
  } finally {
    await page.close();
  }
}

/**
 * Reads the current authenticated user's follower rows from the main followers
 * timeline and captures whether the logged-in account already follows each row.
 *
 * Returns up to `maxFollowers` of the most recent followers (X shows newest first).
 */
export async function fetchOurFollowerEntries(
  meHandle: string,
  maxFollowers = 200,
): Promise<FollowerListEntry[]> {
  return runExclusive(() => fetchOurFollowerEntriesImpl(meHandle, maxFollowers));
}

async function fetchOurFollowerEntriesImpl(
  meHandle: string,
  maxFollowers = 200,
): Promise<FollowerListEntry[]> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  try {
    const candidatePaths = [
      `https://x.com/${meHandle}/followers`,
      `https://x.com/${meHandle}/verified_followers`,
    ];

    let opened = false;
    for (const url of candidatePaths) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await delay(randomBetween(2000, 3500));
        const hasUserCells = await page.locator('[data-testid="primaryColumn"] [data-testid="UserCell"]').count() > 0;
        if (hasUserCells) { opened = true; break; }
      } catch {
        // try next
      }
    }
    if (!opened) {
      logger.warn('Could not open followers page');
      return [];
    }

    const seen = new Map<string, FollowerListEntry>();
    let stableScrolls = 0;

    while (seen.size < maxFollowers && stableScrolls < 4) {
      const newEntries: FollowerListEntry[] = await page.evaluate((ownHandle) => {
        const primary = document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector('main');
        const timeline = primary?.querySelector('[aria-label^="Timeline:"]') ?? primary;
        const cells = Array.from(timeline?.querySelectorAll('[data-testid="UserCell"]') ?? []);
        const entries: FollowerListEntry[] = [];

        for (const cell of cells) {
          const links = Array.from(cell.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'));
          let handle: string | null = null;

          for (const a of links) {
            const href = a.getAttribute('href') ?? '';
            const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:[?#].*)?$/);
            if (!m) continue;
            if (m[1].toLowerCase() === String(ownHandle).toLowerCase()) continue;
            handle = m[1];
            break;
          }

          if (!handle) continue;

          const controls = Array.from(cell.querySelectorAll<HTMLElement>('button,[role="button"]'));
          let followedByUs: boolean | null = null;
          for (const control of controls) {
            const label = [
              control.getAttribute('aria-label'),
              control.getAttribute('data-testid'),
              control.textContent,
            ].filter(Boolean).join(' ').trim();

            if (/\bunfollow\b|following/i.test(label)) {
              followedByUs = true;
              break;
            }
            if (/\bfollow\b/i.test(label)) {
              followedByUs = false;
            }
          }

          entries.push({ handle, followedByUs });
        }

        return entries;
      });

      const before = seen.size;
      for (const entry of newEntries) {
        const key = entry.handle.toLowerCase();
        const existing = seen.get(key);
        if (!existing || (existing.followedByUs === null && entry.followedByUs !== null)) {
          seen.set(key, entry);
        }
      }

      if (seen.size === before) {
        stableScrolls++;
      } else {
        stableScrolls = 0;
      }

      await page.evaluate(() => window.scrollBy(0, 600 + Math.floor(Math.random() * 400)));
      await delay(randomBetween(1500, 2800));
    }

    return Array.from(seen.values()).slice(0, maxFollowers);
  } finally {
    await page.close();
  }
}

/**
 * Performs a follow-back action: navigate to the user's profile and click Follow.
 * Returns true on success.
 */
export async function followBack(handle: string): Promise<boolean> {
  return runExclusive(() => followBackImpl(handle));
}

async function followBackImpl(handle: string): Promise<boolean> {
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

function sanitizeHandle(handle: string): string | null {
  const normalized = handle.trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(normalized) ? normalized : null;
}
