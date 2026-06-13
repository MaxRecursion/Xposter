import type { Locator, Page, Response } from 'playwright';
import { delay } from '../utils/delay.js';

/**
 * Detects and dismisses X overlay popups (Promote ads, upsell dialogs, etc.)
 * that can intercept pointer events and block interaction with the tweet composer.
 *
 * Strategy (in order):
 *   1. Check for the promote popup image specifically
 *   2. Look for any explicit close/dismiss button inside #layers
 *   3. Press Escape up to 3 times with short waits
 *   4. Click the backdrop (top-left of #layers) to dismiss modal
 */
export async function dismissPromotePopup(page: Page): Promise<void> {
  try {
    // Detect promote popup by its image src pattern
    const promoteImg = page.locator('#layers img[src*="promote_popup"]').first();
    const hasPromotePopup = await promoteImg.isVisible({ timeout: 500 }).catch(() => false);

    // Also detect any dialog/modal inside layers that could be blocking
    const anyDialog = page.locator('#layers [role="dialog"], #layers [role="alertdialog"]').first();
    const hasDialog = await anyDialog.isVisible({ timeout: 500 }).catch(() => false);

    if (!hasPromotePopup && !hasDialog) {
      // Check more broadly — if layers has a child with pointer-events that blocks
      const layersChildren = page.locator('#layers > div').first();
      const hasChildren = await layersChildren.isVisible({ timeout: 300 }).catch(() => false);
      if (!hasChildren) return; // No popup visible, nothing to dismiss
    }

    // Try explicit close buttons first (ordered by specificity)
    const closeBtnSelectors = [
      '#layers [data-testid="app-bar-close"]',
      '#layers [aria-label="Close"]',
      '#layers [aria-label="Dismiss"]',
      '#layers button[aria-label*="close" i]',
      '#layers button[aria-label*="dismiss" i]',
      '#layers [role="dialog"] button:last-child',
      '#layers button',
    ];
    for (const sel of closeBtnSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
        await btn.click({ timeout: 2000 }).catch(() => null);
        await delay(600);
        break;
      }
    }

    // Press Escape up to 3 times to clear lingering overlays
    for (let i = 0; i < 3; i++) {
      const stillBlocking = await page.locator('#layers img[src*="promote_popup"]')
        .first().isVisible({ timeout: 300 }).catch(() => false);
      if (!stillBlocking) break;
      await page.keyboard.press('Escape');
      await delay(400);
    }

    // Last resort: click the backdrop area (top-left of viewport, outside any modal)
    const stillBlocking = await page.locator('#layers img[src*="promote_popup"]')
      .first().isVisible({ timeout: 300 }).catch(() => false);
    if (stillBlocking) {
      await page.mouse.click(10, 10);
      await delay(500);
    }
  } catch {
    // Non-fatal — if dismiss fails the click will still time out with a clear error
  }
}

export async function clickWithPopupRetry(page: Page, locator: Locator, attempts = 3): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await locator.click({ timeout: 5000 });
      return;
    } catch {
      await page.keyboard.press('Escape');
      await delay(1000);
    }
  }
  await locator.click({ timeout: 5000 });
}

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
