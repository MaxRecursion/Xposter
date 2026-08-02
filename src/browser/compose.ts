import { getBrowserContext, runExclusive } from './session.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween, mediumDelay, longDelay, humanType } from '../utils/delay.js';
import { findEnabled, findVisible, watchCreateTweetId, dismissPromotePopup, clickWithPopupRetry } from './dom.js';
import { postReply } from './posting.js';
import { getXHandle } from '../config.js';

// Compose textarea inside the modal (appears after navigating to /compose/post)
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

export interface ThreadComposeResult {
  tweetIds: Array<string | null>;
  tweetUrls: Array<string | null>;
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
  return runExclusive(async () => {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  const getCapturedTweetId = watchCreateTweetId(page);

  try {
    logger.info('Composing original tweet', { chars: content.length });

    // 1. Navigate directly to compose/post — opens the compose modal without
    //    needing to find a sidebar button (whose selectors break when X updates).
    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await delay(randomBetween(2500, 4000));

    // 2. Find the textarea inside the compose modal
    const composeBox = await findVisible(page, COMPOSE_BOX_SELECTORS, 15_000);
    if (!composeBox) throw new Error('Compose textarea not found inside compose modal');

    await dismissPromotePopup(page);
    await clickWithPopupRetry(page, composeBox);
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

    const handle = getXHandle();
    const capturedTweetId = getCapturedTweetId();
    const tweetUrl = capturedTweetId && handle
      ? `https://x.com/${handle}/status/${capturedTweetId}`
      : null;

    logger.info('Original tweet posted', { tweetId: capturedTweetId, tweetUrl });
    return { tweetId: capturedTweetId, tweetUrl };
  } finally {
    await page.close();
  }
  });
}

/** Post one original tweet or a 2-3 tweet thread chained through replies. */
export async function postTweetThread(parts: string[]): Promise<ThreadComposeResult> {
  return runExclusive(async () => {
  if (parts.length < 1 || parts.length > 3) {
    throw new Error(`Thread must contain 1-3 parts, received ${parts.length}`);
  }

  const first = await postOriginalTweet(parts[0]);
  const tweetIds: Array<string | null> = [first.tweetId];
  const tweetUrls: Array<string | null> = [first.tweetUrl];

  for (let i = 1; i < parts.length; i++) {
    const previousId = tweetIds[i - 1];
    if (!previousId) {
      throw new Error(`Cannot chain thread part ${i + 1}: previous tweet id was not captured`);
    }

    await delay(randomBetween(2500, 4500));
    const previousUrl = `https://x.com/i/web/status/${previousId}`;
    const result = await postReply(previousUrl, parts[i]);
    const tweetId = result.replyTweetId;
    tweetIds.push(tweetId);
    tweetUrls.push(tweetId ? `https://x.com/i/web/status/${tweetId}` : null);

    if (!tweetId && i < parts.length - 1) {
      throw new Error(`Cannot chain thread part ${i + 2}: part ${i + 1} tweet id was not captured`);
    }
  }

  return { tweetIds, tweetUrls };
  });
}

/**
 * X turns a trailing status URL into a native quote card. Keep commentary
 * separate in storage, but submit both together through the normal composer.
 */
export async function postQuoteTweet(
  commentary: string,
  quotedTweetUrl: string,
): Promise<ComposeResult> {
  return postOriginalTweet(`${commentary.trim()}\n${quotedTweetUrl.trim()}`);
}

/**
 * Post a tweet with an attached image.
 * Opens the compose modal, attaches the image via file input, types the
 * caption, and submits. Returns the tweet ID and URL.
 */
export async function postImageTweet(
  imagePath: string,
  caption: string,
): Promise<ComposeResult> {
  return runExclusive(async () => {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();
  const getCapturedTweetId = watchCreateTweetId(page);

  try {
    logger.info('Composing image tweet', { imagePath, captionLen: caption.length });

    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await delay(randomBetween(2500, 4000));

    // Dismiss any popups first
    await dismissPromotePopup(page);

    // Attach image via the file input (hidden behind the media button)
    const fileInput = page.locator('input[type="file"][accept*="image"]').first();
    await fileInput.setInputFiles(imagePath);
    logger.info('Image file attached, waiting for upload...');

    // Wait for the image preview thumbnail to appear (upload complete)
    await page.waitForSelector('[data-testid="attachments"] img, [data-testid="tweetPhoto"] img', {
      timeout: 30_000,
    }).catch(() => {
      logger.warn('Image preview not detected — proceeding anyway');
    });
    await delay(randomBetween(1500, 2500));

    // Click the compose box and type the caption
    const composeBox = await findVisible(page, COMPOSE_BOX_SELECTORS, 15_000);
    if (!composeBox) throw new Error('Compose textarea not found for image tweet');

    await clickWithPopupRetry(page, composeBox);
    await mediumDelay();
    await humanType(async (char) => page.keyboard.type(char), caption);
    await longDelay();

    // Post
    const postBtn = await findEnabled(page, POST_BTN_SELECTORS, 12_000);
    if (!postBtn) throw new Error('Post button not found or disabled after image attach');

    await postBtn.scrollIntoViewIfNeeded();
    await mediumDelay();
    await postBtn.click();
    await delay(randomBetween(4000, 6000));

    const toast = await page.locator('[data-testid="toast"]').first()
      .textContent({ timeout: 2000 }).catch(() => null);
    if (toast && /error|fail|limit/i.test(toast)) {
      throw new Error(`X returned error toast: ${toast.trim()}`);
    }

    const handle = getXHandle();
    const capturedTweetId = getCapturedTweetId();
    const tweetUrl = capturedTweetId && handle
      ? `https://x.com/${handle}/status/${capturedTweetId}`
      : null;

    logger.info('Image tweet posted', { tweetId: capturedTweetId, tweetUrl });
    return { tweetId: capturedTweetId, tweetUrl };
  } finally {
    await page.close();
  }
  });
}
