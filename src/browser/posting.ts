import { Locator, Page, Response } from 'playwright';
import { getBrowserContext } from './session.js';
import { logger } from '../utils/logger.js';
import { mediumDelay, longDelay, humanType, delay, randomBetween } from '../utils/delay.js';
import { extractTweetIdFromUrl } from '../utils/x.js';
import { findEnabled, findVisible, watchCreateTweetId } from './dom.js';
import { PostingError } from '../pipeline/errors.js';

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
    throw new PostingError(`Invalid tweet URL: ${tweetUrl}`, 'INVALID_TWEET_URL', false);
  }

  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  const getCapturedReplyTweetId = watchCreateTweetId(page, { excludeTweetId: tweetId });

  try {
    logger.info('Opening tweet for reply', { tweetUrl, tweetId });
    try {
      await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      throw new PostingError(`Tweet navigation failed: ${String(err)}`, 'NAVIGATION_FAILED', true);
    }
    await delay(randomBetween(2500, 4000));

    const article = await findVisible(page, TWEET_ARTICLE_SELECTORS, 20_000);
    if (!article) {
      const unavailable = await page.getByText(
        /post is unavailable|tweet is unavailable|doesn.t exist|has been deleted/i,
      ).first().isVisible().catch(() => false);
      if (unavailable) {
        throw new PostingError('Source tweet is unavailable or deleted', 'SOURCE_UNAVAILABLE', false);
      }
      throw new PostingError('Tweet article not found after page load', 'TWEET_NOT_LOADED', true);
    }

    let composeBox = await findVisible(page, COMPOSE_BOX_SELECTORS, 2_000);
    if (!composeBox) {
      const replyBtn = await findVisible(page, REPLY_BTN_SELECTORS, 15_000);
      if (!replyBtn) {
        throw new PostingError('Reply button not found', 'REPLY_CONTROL_NOT_FOUND', true);
      }

      await replyBtn.scrollIntoViewIfNeeded();
      await mediumDelay();
      await replyBtn.click();
      await longDelay();

      composeBox = await findVisible(page, COMPOSE_BOX_SELECTORS, 15_000);
    }

    if (!composeBox) {
      throw new PostingError('Compose box not found after clicking reply', 'COMPOSE_NOT_FOUND', true);
    }

    await composeBox.click();
    await mediumDelay();

    // Type reply with human-like character delays
    await humanType(async (char) => {
      await page.keyboard.type(char);
    }, replyText);

    await longDelay();

    // Submit
    const submitBtn = await findEnabled(page, SUBMIT_BTN_SELECTORS, 10_000);
    if (!submitBtn) {
      throw new PostingError('Submit button not found', 'SUBMIT_NOT_FOUND', true);
    }

    await submitBtn.click();

    // Wait briefly to confirm no error toast
    await delay(randomBetween(3000, 5000));

    const errorToast = await page.locator('[data-testid="toast"]').first().textContent()
      .catch(() => null);

    if (errorToast?.toLowerCase().includes('error') || errorToast?.toLowerCase().includes('failed')) {
      throw new PostingError(`X returned error toast: ${errorToast}`, 'X_REJECTED', false);
    }

    const capturedReplyTweetId = getCapturedReplyTweetId();
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
    const caret = await findVisible(article, CARET_BTN_SELECTORS, 10_000);
    if (!caret) throw new Error('Caret/More menu not found on reply');

    await caret.scrollIntoViewIfNeeded();
    await mediumDelay();
    await caret.click();
    await longDelay();

    const deleteItem = await findVisible(page, DELETE_MENU_ITEM_SELECTORS, 8_000);
    if (!deleteItem) {
      throw new Error('Delete menu item not found - this reply may not be authored by the logged-in user');
    }
    await deleteItem.click();
    await mediumDelay();

    const confirmBtn = await findEnabled(page, CONFIRM_DELETE_SELECTORS, 8_000);
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
