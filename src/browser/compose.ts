import { Page, Response } from 'playwright';
import { getBrowserContext } from './session.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween, mediumDelay, longDelay, humanType } from '../utils/delay.js';

// Sidebar "Post" / compose button — opens the full compose modal
const SIDEBAR_COMPOSE_SELECTORS = [
  '[data-testid="SideNav_NewTweet_Button"]',
  'a[href="/compose/post"]',
  'a[href="/compose/tweet"]',
  '[aria-label="Post"][role="link"]',
];

// Compose textarea inside the modal (appears after opening the modal)
const COMPOSE_BOX_SELECTORS = [
  '[data-testid="tweetTextarea_0"]',
  'div[role="textbox"][contenteditable="true"]',
  'div[contenteditable="true"][aria-label*="post" i]',
  'div[contenteditable="true"]',
];

const POST_BTN_SELECTORS = [
  '[data-testid="tweetButton"]',
  'button[data-testid="tweetButton"]',
  '[role="button"][data-testid="tweetButton"]',
];

export interface ComposeResult {
  tweetId: string | null;
  tweetUrl: string | null;
}

/**
 * Composes and posts a brand-new tweet (not a reply).
 *
 * Flow:
 *   1. Navigate to https://x.com/home
 *   2. Click the compose box ("What is happening?!")
 *   3. Type content with human-like delays
 *   4. Click Post; capture the tweet ID from the CreateTweet GraphQL response
 *   5. Return { tweetId, tweetUrl }
 */
export async function postOriginalTweet(content: string): Promise<ComposeResult> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  let capturedTweetId: string | null = null;

  // Intercept the CreateTweet GraphQL response to get the new tweet's ID without
  // needing fragile DOM scraping of a post-submit toast.
  page.on('response', (response: Response) => {
    if (!response.url().includes('CreateTweet') || response.status() !== 200) return;
    response.json().then((body) => {
      const restId =
        body?.data?.create_tweet?.tweet_results?.result?.rest_id ??
        body?.data?.create_tweet?.tweet_results?.result?.legacy?.id_str;
      if (restId && /^\d+$/.test(String(restId))) {
        capturedTweetId = String(restId);
      }
    }).catch(() => undefined);
  });

  try {
    logger.info('Composing original tweet', { chars: content.length });

    // 1. Land on home and open the compose modal via the sidebar button.
    //    The modal gives us a reliably-editable textarea (unlike the inline home compose box).
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await delay(randomBetween(2500, 4000));

    const sidebarBtn = await findVisible(page, SIDEBAR_COMPOSE_SELECTORS, 15_000);
    if (!sidebarBtn) throw new Error('Sidebar compose button not found on x.com/home');

    await sidebarBtn.click();
    await longDelay(); // wait for compose modal to animate in

    // 2. Find the textarea inside the modal
    const composeBox = await findVisible(page, COMPOSE_BOX_SELECTORS, 15_000);
    if (!composeBox) throw new Error('Compose textarea not found inside compose modal');

    await composeBox.click();
    await mediumDelay();

    // 3. Type content character-by-character (human-like)
    await humanType(async (char) => page.keyboard.type(char), content);
    await longDelay();

    // 4. Find the enabled Post button (it becomes enabled once text is present)
    const postBtn = await findEnabled(page, POST_BTN_SELECTORS, 12_000);
    if (!postBtn) throw new Error('Post button not found or still disabled after typing');

    await postBtn.scrollIntoViewIfNeeded();
    await mediumDelay();
    await postBtn.click();

    // Wait for the API response to arrive (captured by the listener above)
    await delay(randomBetween(4000, 6000));

    // Sanity-check: if a visible error toast appeared, throw
    const toast = await page.locator('[data-testid="toast"]').first()
      .textContent({ timeout: 2000 }).catch(() => null);
    if (toast && /error|fail|limit/i.test(toast)) {
      throw new Error(`X returned error toast: ${toast.trim()}`);
    }

    const handle = process.env.X_HANDLE;
    const tweetUrl = capturedTweetId && handle
      ? `https://x.com/${handle}/status/${capturedTweetId}`
      : null;

    logger.info('Original tweet posted', { tweetId: capturedTweetId, tweetUrl });
    return { tweetId: capturedTweetId, tweetUrl };
  } finally {
    await page.close();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findVisible(page: Page, selectors: string[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count() > 0 && await loc.isVisible({ timeout: 400 })) return loc;
      } catch { /* try next */ }
    }
    await delay(300);
  }
  return null;
}

async function findEnabled(page: Page, selectors: string[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count() === 0) continue;
        if (!await loc.isVisible({ timeout: 400 })) continue;
        const ariaDisabled = await loc.getAttribute('aria-disabled').catch(() => null);
        if (ariaDisabled === 'true') continue;
        if (!await loc.isEnabled().catch(() => false)) continue;
        return loc;
      } catch { /* try next */ }
    }
    await delay(300);
  }
  return null;
}
