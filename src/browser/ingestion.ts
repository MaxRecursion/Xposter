import { Page } from 'playwright';
import { getBrowserContext } from './session.js';
import { RawTweet } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';

const X_HOME = 'https://x.com/home';

// Ordered selector strategies — tried in sequence.
// Using data-testid attributes which are more stable than class names.
const TWEET_SELECTORS = [
  'article[data-testid="tweet"]',
  'article[role="article"]',
  '[data-testid="tweet"]',
];

const TEXT_SELECTORS = [
  '[data-testid="tweetText"]',
  '[lang]',
  'div[dir="auto"]',
];

const TIMESTAMP_SELECTORS = [
  'time[datetime]',
  'time',
];

interface RawEngagement {
  likes: number;
  replies: number;
  retweets: number;
}

export async function ingestTimeline(maxPosts = 40): Promise<RawTweet[]> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  try {
    logger.info('Navigating to X timeline');
    await page.goto(X_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await delay(randomBetween(2000, 3500));

    // Wait for any tweet selector to appear
    const tweetSel = await waitForAnySelector(page, TWEET_SELECTORS, 20_000);
    if (!tweetSel) {
      logger.warn('No tweet selector found — possibly not logged in or timeline empty');
      return [];
    }

    const tweets = await scrollAndCollect(page, tweetSel, maxPosts);
    logger.info(`Collected ${tweets.length} raw tweets from timeline`);
    return tweets;
  } finally {
    await page.close();
  }
}

async function scrollAndCollect(
  page: Page,
  tweetSel: string,
  maxPosts: number,
): Promise<RawTweet[]> {
  const seen = new Set<string>();
  const results: RawTweet[] = [];
  let scrollAttempts = 0;
  const maxScrolls = 8;

  while (results.length < maxPosts && scrollAttempts < maxScrolls) {
    const batch = await extractTweetsFromPage(page, tweetSel);

    for (const tweet of batch) {
      if (!seen.has(tweet.tweet_id)) {
        seen.add(tweet.tweet_id);
        results.push(tweet);
      }
    }

    if (results.length >= maxPosts) break;

    // Human-like scroll
    await page.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 400) + 600));
    await delay(randomBetween(1500, 2800));
    scrollAttempts++;
  }

  return results.slice(0, maxPosts);
}

async function extractTweetsFromPage(
  page: Page,
  tweetSel: string,
): Promise<RawTweet[]> {
  return page.evaluate(
    ({ tweetSel, textSels, timeSels }) => {
      const articles = Array.from(document.querySelectorAll(tweetSel));
      const results: any[] = [];

      for (const article of articles) {
        try {
          let text = '';
          for (const sel of textSels) {
            const found = article.querySelector(sel);
            const candidate = found?.textContent?.trim();
            if (candidate) {
              text = candidate;
              break;
            }
          }
          if (!text) continue;

          // Extract tweet URL + ID from timestamp link
          const timeEl = article.querySelector(timeSels[0]) ?? article.querySelector(timeSels[1]);
          const timeLink = timeEl?.closest('a') as HTMLAnchorElement | null;
          const href = timeLink?.href ?? '';
          const idMatch = href.match(/status\/(\d+)/);
          if (!idMatch) continue;

          const tweetId = idMatch[1];
          const tweetUrl = href;

          // Author handle: look for @handle pattern
          let authorHandle = '';
          let authorName = '';
          const userNameDiv = article.querySelector('[data-testid="User-Name"]');
          if (userNameDiv) {
            const spans = Array.from(userNameDiv.querySelectorAll('span'));
            for (const span of spans) {
              const spanText = span.textContent?.trim() ?? '';
              if (!spanText) continue;
              if (!authorHandle && spanText.startsWith('@')) {
                authorHandle = spanText.replace('@', '').trim();
              } else if (!authorName) {
                authorName = spanText;
              }
            }
            authorName = authorName || authorHandle;
          }

          if (!authorHandle) continue;

          const timestamp = timeEl?.getAttribute('datetime')
            ? new Date(timeEl.getAttribute('datetime')!).getTime()
            : Date.now();

          let likes = 0;
          let replies = 0;
          let retweets = 0;
          for (const metric of [
            { key: 'likes', testid: 'like' },
            { key: 'replies', testid: 'reply' },
            { key: 'retweets', testid: 'retweet' },
          ]) {
            const btn = article.querySelector(`[data-testid="${metric.testid}"]`);
            const spanText = btn?.querySelector('span[data-testid]')?.textContent?.trim()
              ?? btn?.querySelector('span')?.textContent?.trim()
              ?? '0';
            const n = parseFloat(spanText.replace(/[^0-9.KMk]/g, ''));
            let value = 0;
            if (!Number.isNaN(n)) {
              if (spanText.toLowerCase().includes('k')) value = Math.round(n * 1000);
              else if (spanText.toLowerCase().includes('m')) value = Math.round(n * 1_000_000);
              else value = n;
            }
            if (metric.key === 'likes') likes = value;
            if (metric.key === 'replies') replies = value;
            if (metric.key === 'retweets') retweets = value;
          }

          results.push({
            tweet_id: tweetId,
            author_handle: authorHandle,
            author_name: authorName,
            text,
            timestamp: Math.floor(timestamp / 1000),
            likes,
            replies,
            retweets,
            tweet_url: tweetUrl,
          });
        } catch {
          // skip malformed tweet
        }
      }

      return results;
    },
    { tweetSel, textSels: TEXT_SELECTORS, timeSels: TIMESTAMP_SELECTORS },
  );
}

async function waitForAnySelector(
  page: Page,
  selectors: string[],
  timeout: number,
): Promise<string | null> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const count = await page.locator(sel).count();
        if (count > 0) return sel;
      } catch {
        // ignore
      }
    }
    await delay(500);
  }
  return null;
}
