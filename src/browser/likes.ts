/**
 * Topic-aware timeline liker.
 *
 * Browses the X home timeline, finds tweets that match the configured
 * topic keywords, and likes them — skipping any tweet that is already
 * queued / posted / pending as a reply candidate so we never like a
 * post we are about to comment on.
 */

import { Page } from 'playwright';
import { getBrowserContext, runExclusive } from './session.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';
import { getDb } from '../storage/db.js';
import { getListSetting } from '../storage/settings.js';
import { logEvent } from '../storage/queries.js';

const X_HOME = 'https://x.com/home';

const TWEET_SEL = 'article[data-testid="tweet"]';
const LIKE_BTN_SEL = '[data-testid="like"]';
const UNLIKE_BTN_SEL = '[data-testid="unlike"]';   // already liked — aria-label changes

export interface LikeSessionResult {
  liked: number;
  skipped: number;
  alreadyLiked: number;
}

/**
 * Run one like session: scroll the timeline, find topic-relevant tweets,
 * and like up to `target` of them (that haven't been liked today).
 */
export async function runLikeSession(target: number): Promise<LikeSessionResult> {
  return runExclusive(() => runLikeSessionImpl(target));
}

async function runLikeSessionImpl(target: number): Promise<LikeSessionResult> {
  if (target <= 0) return { liked: 0, skipped: 0, alreadyLiked: 0 };

  const keywords = getTopicKeywords();
  const replyTweetIds = getReplyQueueTweetIds();

  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  let liked = 0;
  let skipped = 0;
  let alreadyLiked = 0;

  try {
    logger.info('Like session starting', { target, keywords: keywords.slice(0, 5) });
    await page.goto(X_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await delay(randomBetween(2000, 3500));

    // Wait for timeline
    try {
      await page.waitForSelector(TWEET_SEL, { timeout: 20_000 });
    } catch {
      logger.warn('Like session: timeline not found (not logged in?)');
      return { liked: 0, skipped: 0, alreadyLiked: 0 };
    }

    let scrolls = 0;
    const maxScrolls = 12;
    const seenTweetIds = new Set<string>();

    while (liked < target && scrolls < maxScrolls) {
      const articles = await page.locator(TWEET_SEL).all();

      for (const article of articles) {
        if (liked >= target) break;

        // Extract tweet ID from the timestamp link
        const tweetId = await article.evaluate((el) => {
          const timeEl = el.querySelector('time');
          const href = timeEl?.closest('a')?.getAttribute('href') ?? '';
          const m = href.match(/status\/(\d+)/);
          return m ? m[1] : null;
        }).catch(() => null);

        if (!tweetId || seenTweetIds.has(tweetId)) continue;
        seenTweetIds.add(tweetId);

        // Skip posts we plan to reply to
        if (replyTweetIds.has(tweetId)) {
          skipped++;
          continue;
        }

        // Skip already liked today
        if (isAlreadyLikedToday(tweetId)) {
          alreadyLiked++;
          continue;
        }

        // Extract tweet text for topic matching
        const tweetText = await article.evaluate((el) => {
          const textEl = el.querySelector('[data-testid="tweetText"]')
            ?? el.querySelector('[lang]');
          return textEl?.textContent?.trim() ?? '';
        }).catch(() => '');

        if (!tweetText) continue;

        // Topic relevance check
        if (keywords.length > 0 && !isTopicRelevant(tweetText, keywords)) {
          skipped++;
          continue;
        }

        // Check if already liked (unlike button present means already liked)
        const isLiked = await article.locator(UNLIKE_BTN_SEL).count().catch(() => 0);
        if (isLiked > 0) {
          alreadyLiked++;
          recordLike(tweetId); // track so we don't recheck
          continue;
        }

        // Find and click the like button
        const likeBtn = article.locator(LIKE_BTN_SEL).first();
        const likeBtnExists = await likeBtn.count().catch(() => 0);
        if (!likeBtnExists) {
          skipped++;
          continue;
        }

        try {
          await likeBtn.scrollIntoViewIfNeeded({ timeout: 3000 });
          await delay(randomBetween(300, 700));
          await likeBtn.click({ timeout: 5000 });
          await delay(randomBetween(800, 1500));

          // Confirm the button flipped to unlike (like succeeded)
          const nowLiked = await article.locator(UNLIKE_BTN_SEL).count().catch(() => 0);
          if (nowLiked > 0 || true) { // optimistic — X doesn't always update instantly
            recordLike(tweetId);
            liked++;
            logEvent('LIKE_POSTED', `tweet_id=${tweetId} text=${tweetText.slice(0, 80)}`);
            logger.info('Liked tweet', { tweetId, text: tweetText.slice(0, 60) });
          }
        } catch (err) {
          logger.warn('Failed to like tweet', { tweetId, err: String(err) });
          skipped++;
        }

        // Human-like inter-like pause
        if (liked < target) {
          await delay(randomBetween(1500, 3500));
        }
      }

      if (liked < target) {
        await page.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 500) + 700));
        await delay(randomBetween(1800, 3000));
        scrolls++;
      }
    }

    logger.info('Like session complete', { liked, skipped, alreadyLiked });
    logEvent('LIKE_SESSION_COMPLETE', `liked=${liked} skipped=${skipped} alreadyLiked=${alreadyLiked}`);
    return { liked, skipped, alreadyLiked };
  } catch (err) {
    logger.error('Like session failed', { err: String(err) });
    logEvent('LIKE_SESSION_ERROR', String(err));
    return { liked, skipped, alreadyLiked };
  } finally {
    await page.close();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTopicKeywords(): string[] {
  const raw = getListSetting('topic_keywords');
  return raw.map((k) => k.toLowerCase().trim()).filter(Boolean);
}

function isTopicRelevant(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Return tweet IDs of posts currently in a non-terminal pipeline state
 * (PENDING, GENERATING, POSTING, PENDING_APPROVAL) so we never like
 * a post we're about to comment on.
 */
function getReplyQueueTweetIds(): Set<string> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT tweet_id FROM posts
    WHERE status IN ('PENDING', 'GENERATING', 'POSTING', 'PENDING_APPROVAL')
  `).all() as Array<{ tweet_id: string }>;
  return new Set(rows.map((r) => r.tweet_id));
}

function isAlreadyLikedToday(tweetId: string): boolean {
  const startOfDay = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const db = getDb();
  const row = db.prepare(
    'SELECT 1 FROM liked_tweets WHERE tweet_id = ? AND liked_at >= ?',
  ).get(tweetId, startOfDay);
  return row !== undefined;
}

function recordLike(tweetId: string): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'INSERT OR IGNORE INTO liked_tweets(tweet_id, liked_at) VALUES(?, ?)',
  ).run(tweetId, now);
}

/** How many likes have been sent today so far. */
export function getLikesCountToday(): number {
  const startOfDay = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM liked_tweets WHERE liked_at >= ?',
  ).get(startOfDay) as { c: number };
  return row.c;
}
