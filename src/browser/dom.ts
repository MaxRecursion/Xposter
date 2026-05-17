import type { Locator, Page, Response } from 'playwright';
import { delay } from '../utils/delay.js';

export type LocatorScope = Page | Locator;

export async function findVisible(
  scope: LocatorScope,
  selectors: string[],
  timeoutMs = 5_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const locator = scope.locator(selector).first();
        if (await locator.count() > 0 && await locator.isVisible({ timeout: 500 })) {
          return locator;
        }
      } catch {
        // Try the next selector while X finishes hydrating the UI.
      }
    }
    await delay(250);
  }

  return null;
}

export async function findEnabled(
  scope: LocatorScope,
  selectors: string[],
  timeoutMs = 5_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const locator = await findVisible(scope, selectors, 500);
    if (locator) {
      const ariaDisabled = await locator.getAttribute('aria-disabled').catch(() => null);
      const disabled = await locator.getAttribute('disabled').catch(() => null);
      const enabled = await locator.isEnabled().catch(() => true);
      if (enabled && ariaDisabled !== 'true' && disabled === null) return locator;
    }
    await delay(250);
  }

  return null;
}

export function watchCreateTweetId(
  page: Page,
  opts: { excludeTweetId?: string } = {},
): () => string | null {
  let capturedTweetId: string | null = null;

  page.on('response', (response: Response) => {
    if (!response.url().includes('CreateTweet') || response.status() !== 200) return;
    response.json().then((body) => {
      const restId =
        body?.data?.create_tweet?.tweet_results?.result?.rest_id ??
        body?.data?.create_tweet?.tweet_results?.result?.legacy?.id_str;
      const id = String(restId ?? '');
      if (/^\d+$/.test(id) && id !== opts.excludeTweetId) {
        capturedTweetId = id;
      }
    }).catch(() => undefined);
  });

  return () => capturedTweetId;
}
