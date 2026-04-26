import { Locator, Page } from 'playwright';
import { getBrowserContext } from './session.js';
import { logger } from '../utils/logger.js';
import { mediumDelay, longDelay, humanType, delay, randomBetween } from '../utils/delay.js';
import { extractTweetIdFromUrl } from '../utils/x.js';

const TWEET_ARTICLE_SELECTORS = [
  'article[data-testid="tweet"]',
  'article[role="article"]',
];

// Ordered selector strategies for the reply button on a tweet.
// Multiple strategies so we survive DOM changes.
const REPLY_BTN_SELECTORS = [
  '[data-testid="reply"]',
  '[role="button"][data-testid="reply"]',
  'button[aria-label*="reply" i]',
  'div[role="button"][aria-label*="reply" i]',
  '[role="button"][aria-label*="respond" i]',
];

// Where X renders the tweet reply compose box
const COMPOSE_BOX_SELECTORS = [
  '[data-testid="tweetTextarea_0"]',
  '[data-testid="tweetTextarea"]',
  'div[role="textbox"][aria-label*="reply" i]',
  'div[role="textbox"]',
];

const SUBMIT_BTN_SELECTORS = [
  '[data-testid="tweetButton"]',
  '[data-testid="tweetButtonInline"]',
  'button[aria-label*="reply" i]',
  '[role="button"][aria-label*="reply" i]',
  'button[aria-label*="post" i]',
  '[role="button"][aria-label*="post" i]',
];

export async function postReply(tweetUrl: string, replyText: string): Promise<void> {
  const tweetId = extractTweetIdFromUrl(tweetUrl);
  if (!tweetId) {
    throw new Error(`Invalid tweet URL: ${tweetUrl}`);
  }

  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  try {
    logger.info('Opening tweet for reply', { tweetUrl, tweetId });
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await delay(randomBetween(2500, 4000));

    const article = await findElement(page, TWEET_ARTICLE_SELECTORS, 20_000);
    if (!article) {
      throw new Error('Tweet article not found - check login/session or tweet availability');
    }

    let composeBox = await findElement(page, COMPOSE_BOX_SELECTORS, 2_000);
    if (!composeBox) {
      const replyBtn = await findElement(page, REPLY_BTN_SELECTORS, 15_000);
      if (!replyBtn) throw new Error('Reply button not found');

      await replyBtn.scrollIntoViewIfNeeded();
      await mediumDelay();
      await replyBtn.click();
      await longDelay();

      composeBox = await findElement(page, COMPOSE_BOX_SELECTORS, 15_000);
    }

    if (!composeBox) throw new Error('Compose box not found after clicking reply');

    await composeBox.click();
    await mediumDelay();

    // Type reply with human-like character delays
    await humanType(async (char) => {
      await page.keyboard.type(char);
    }, replyText);

    await longDelay();

    // Submit
    const submitBtn = await findEnabledElement(page, SUBMIT_BTN_SELECTORS, 10_000);
    if (!submitBtn) throw new Error('Submit button not found');

    await submitBtn.click();

    // Wait briefly to confirm no error toast
    await delay(randomBetween(3000, 5000));

    const errorToast = await page.locator('[data-testid="toast"]').first().textContent()
      .catch(() => null);

    if (errorToast?.toLowerCase().includes('error') || errorToast?.toLowerCase().includes('failed')) {
      throw new Error(`X returned error toast: ${errorToast}`);
    }

    logger.info('Reply posted successfully', { tweetUrl, replyLength: replyText.length });
  } finally {
    await page.close();
  }
}

async function findElement(
  page: Page,
  selectors: string[],
  timeoutMs = 5_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count() > 0 && await loc.isVisible({ timeout: 500 })) {
          return loc;
        }
      } catch {
        // try next
      }
    }
    await delay(250);
  }

  return null;
}

async function findEnabledElement(
  page: Page,
  selectors: string[],
  timeoutMs = 5_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const loc = await findElement(page, selectors, 500);
    if (loc) {
      const ariaDisabled = await loc.getAttribute('aria-disabled').catch(() => null);
      const disabled = await loc.getAttribute('disabled').catch(() => null);
      const enabled = await loc.isEnabled().catch(() => true);
      if (enabled && ariaDisabled !== 'true' && disabled === null) return loc;
    }
    await delay(250);
  }

  return null;
}
