import { Locator, Page, Response } from 'playwright';
import { getBrowserContext } from './session.js';
import { logger } from '../utils/logger.js';
import { mediumDelay, longDelay, humanType, delay, randomBetween } from '../utils/delay.js';
import { extractTweetIdFromUrl } from '../utils/x.js';

export interface PostReplyResult {
  replyTweetId: string | null;
}

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

export async function postReply(tweetUrl: string, replyText: string): Promise<PostReplyResult> {
  const tweetId = extractTweetIdFromUrl(tweetUrl);
  if (!tweetId) {
    throw new Error(`Invalid tweet URL: ${tweetUrl}`);
  }

  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  let capturedReplyTweetId: string | null = null;

  // Intercept the CreateTweet GraphQL response so we can return the new reply's ID
  // without scraping the toast or the timeline. Same pattern compose.ts uses.
  page.on('response', (response: Response) => {
    if (!response.url().includes('CreateTweet') || response.status() !== 200) return;
    response.json().then((body) => {
      const restId =
        body?.data?.create_tweet?.tweet_results?.result?.rest_id ??
        body?.data?.create_tweet?.tweet_results?.result?.legacy?.id_str;
      if (restId && /^\d+$/.test(String(restId)) && String(restId) !== tweetId) {
        capturedReplyTweetId = String(restId);
      }
    }).catch(() => undefined);
  });

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

    logger.info('Reply posted successfully', {
      tweetUrl, replyLength: replyText.length, replyTweetId: capturedReplyTweetId,
    });
    return { replyTweetId: capturedReplyTweetId };
  } finally {
    await page.close();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Delete a reply we previously posted.
// ────────────────────────────────────────────────────────────────────────────

const CARET_BTN_SELECTORS = [
  '[data-testid="caret"]',
  'article[data-testid="tweet"] [data-testid="caret"]',
  'article[role="article"] [aria-label*="More" i]',
  '[role="button"][aria-haspopup="menu"]',
];

const DELETE_MENU_ITEM_SELECTORS = [
  '[data-testid="Dropdown"] [role="menuitem"]:has-text("Delete")',
  '[role="menu"] [role="menuitem"]:has-text("Delete")',
  '[data-testid*="Delete" i]',
  'div[role="menuitem"]:has-text("Delete")',
];

const CONFIRM_DELETE_SELECTORS = [
  '[data-testid="confirmationSheetConfirm"]',
  'button[data-testid="confirmationSheetConfirm"]',
  '[role="button"]:has-text("Delete")',
];

export async function deleteReply(replyTweetId: string): Promise<void> {
  if (!/^\d+$/.test(replyTweetId)) {
    throw new Error(`Invalid reply tweet id: ${replyTweetId}`);
  }
  const url = `https://x.com/i/web/status/${replyTweetId}`;

  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  let deleteRequestObserved = false;
  page.on('response', (response: Response) => {
    if (response.url().includes('DeleteTweet') && response.status() === 200) {
      deleteRequestObserved = true;
    }
  });

  try {
    logger.info('Opening reply for deletion', { url, replyTweetId });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await delay(randomBetween(2500, 4000));

    const article = await findTweetArticleById(page, replyTweetId, 15_000);
    if (!article) {
      throw new Error('Target reply article not found - refusing to click delete on a different tweet');
    }

    // Scope the "..." lookup to the target reply article so we never act on the
    // original tweet higher up in the thread.
    const caret = await findElement(article, CARET_BTN_SELECTORS, 10_000);
    if (!caret) throw new Error('Caret/More menu not found on reply');

    await caret.scrollIntoViewIfNeeded();
    await mediumDelay();
    await caret.click();
    await longDelay();

    const deleteItem = await findElement(page, DELETE_MENU_ITEM_SELECTORS, 8_000);
    if (!deleteItem) {
      throw new Error('Delete menu item not found - this reply may not be authored by the logged-in user');
    }
    await deleteItem.click();
    await mediumDelay();

    const confirmBtn = await findEnabledElement(page, CONFIRM_DELETE_SELECTORS, 8_000);
    if (!confirmBtn) throw new Error('Delete confirmation button not found');
    await confirmBtn.click();

    await delay(randomBetween(2500, 4000));

    if (!deleteRequestObserved) {
      // Soft warning — we don't always intercept the response, but the click did go through.
      logger.warn('DeleteTweet GraphQL response not observed (deletion may still have succeeded)', {
        replyTweetId,
      });
    }

    logger.info('Reply deleted successfully', { replyTweetId, deleteRequestObserved });
  } finally {
    await page.close();
  }
}

async function findTweetArticleById(
  page: Page,
  tweetId: string,
  timeoutMs = 5_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  const tweetLink = page.locator(`a[href*="/status/${tweetId}"]`).first();
  const articles = page.locator(TWEET_ARTICLE_SELECTORS.join(',')).filter({ has: tweetLink });

  while (Date.now() < deadline) {
    try {
      const article = articles.first();
      if (await article.count() > 0 && await article.isVisible({ timeout: 500 })) {
        return article;
      }
    } catch {
      // Wait for X to finish hydrating the tweet thread.
    }
    await delay(250);
  }

  return null;
}

async function findElement(
  scope: Page | Locator,
  selectors: string[],
  timeoutMs = 5_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = scope.locator(sel).first();
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
