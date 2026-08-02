import {
  getDuePendingRuns, getScheduledRunsForDate, getUpcomingRuns,
  insertScheduledRun, markRunError, markRunFired, markRunSkipped,
  rescheduleRun, retryCountFromDetail, withRetryDetail, ScheduledRun,
} from '../storage/scheduled_runs.js';
import {
  insertOriginalPost, markOriginalPostPosted, markOriginalPostError,
  getPostsNeedingImpressionSync, insertImpression, listRecentOriginalPostContents,
} from '../storage/original_posts.js';
import {
  generateEngagementFarmPost, generateOriginalPost, generateQuoteTweetPost,
} from '../pipeline/original_post_generator.js';
import { EmptyReplyError } from '../pipeline/errors.js';
import type { OriginalPostType } from '../storage/original_posts.js';
import { postQuoteTweet, postTweetThread } from '../browser/compose.js';
import { scrapeEngagement } from '../browser/impressions.js';
import { logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';
import { formatLocalTime, generateWeightedSlots, todayDateKey } from './daily_plan.js';
import { getBooleanSetting, getIntSetting } from '../storage/settings.js';
import { generateDistinct } from '../pipeline/dedup.js';
import { selectQuoteTweetCandidate, type QuoteTweetCandidate } from '../context/trends.js';

const KIND = 'ORIGINAL_POST';
const TICK_INTERVAL_MS = 60_000;
const IMPRESSION_SYNC_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_TRANSIENT_RETRIES = 2;
const RESCHEDULE_DELAY_SEC = 15 * 60;

let _tickHandle: NodeJS.Timeout | null = null;
let _syncHandle: NodeJS.Timeout | null = null;
let _syncBootHandle: NodeJS.Timeout | null = null;
let _posting = false;

// ── Public API ────────────────────────────────────────────────────────────────

export function startOriginalPostScheduler(): void {
  ensureTodayOriginalPlan();
  if (_tickHandle) return;

  _tickHandle = setInterval(tick, TICK_INTERVAL_MS);
  void tick(); // check immediately on boot

  // Impression sync: first run 10 min after boot (let things settle), then every 2h
  _syncBootHandle = setTimeout(() => {
    void runImpressionSync();
    _syncHandle = setInterval(() => { void runImpressionSync(); }, IMPRESSION_SYNC_MS);
  }, 10 * 60_000);

  logger.info('Original post scheduler started (originals + engagement farms + quote tweets, 2h impression sync)');
}

export function stopOriginalPostScheduler(): void {
  if (_tickHandle) { clearInterval(_tickHandle); _tickHandle = null; }
  if (_syncHandle) { clearInterval(_syncHandle); _syncHandle = null; }
  if (_syncBootHandle) { clearTimeout(_syncBootHandle); _syncBootHandle = null; }
}

/** Public handle for the API "trigger now" endpoint. */
export async function triggerOriginalPost(): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (_posting) return { ok: false, error: 'Already posting — try again in a moment' };
  return fireOnePost('manual-trigger', 'ORIGINAL');
}

export function ensureTodayOriginalPlan(): ScheduledRun[] {
  const dateKey = todayDateKey();
  const existing = getScheduledRunsForDate(dateKey, KIND);
  if (existing.length > 0) return existing;

  const slots = generateRandomSlots(dateKey);
  for (const { ts, postType } of slots) insertScheduledRun(dateKey, ts, KIND, postType);

  const created = getScheduledRunsForDate(dateKey, KIND);
  logEvent(
    'ORIGINAL_SCHEDULE_CREATED',
    `${created.length} posts at: ${created.map((r) => formatLocalTime(r.run_at)).join(', ')}`,
  );
  logger.info("Today's original post plan created", {
    date: dateKey,
    times: created.map((r) => formatLocalTime(r.run_at)),
  });
  return created;
}

export function getTodayOriginalPlan(): ScheduledRun[] {
  return getScheduledRunsForDate(todayDateKey(), KIND);
}

export function getNextOriginalRuns(limit = 5): ScheduledRun[] {
  return getUpcomingRuns(Math.floor(Date.now() / 1000), limit, KIND);
}

// ── Impression sync ───────────────────────────────────────────────────────────

export async function runImpressionSync(): Promise<{ synced: number }> {
  if (!getBooleanSetting('system_running', true)) return { synced: 0 };

  const posts = getPostsNeedingImpressionSync(IMPRESSION_SYNC_MS / 1000);
  if (posts.length === 0) return { synced: 0 };

  logger.info('Impression sync starting', { count: posts.length });
  logEvent('IMPRESSION_SYNC_START', `${posts.length} posts`);

  let synced = 0;
  for (const post of posts) {
    if (!post.tweet_url) continue;
    try {
      const data = await scrapeEngagement(post.tweet_url);
      insertImpression({
        originalPostId: post.id,
        tweetId: post.tweet_id!,
        ...data,
      });
      synced++;
      logger.info('Impressions recorded', {
        postId: post.id,
        likes: data.likes,
        replies: data.replies,
        impressions: data.impressions,
      });
    } catch (err) {
      logger.warn('Impression scrape failed', { postId: post.id, err: String(err) });
    }
    await delay(randomBetween(3000, 6000));
  }

  logEvent('IMPRESSION_SYNC_COMPLETE', `synced ${synced}/${posts.length}`);
  return { synced };
}

// ── Private ───────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  ensureTodayOriginalPlan();

  if (!getBooleanSetting('system_running', true)) return;
  if (_posting) return;

  const due = getDuePendingRuns(Math.floor(Date.now() / 1000), KIND);
  if (due.length === 0) return;

  const next = due[0];
  const postType: OriginalPostType = next.detail === 'ENGAGEMENT_FARM'
    || next.detail?.startsWith('ENGAGEMENT_FARM')
    ? 'ENGAGEMENT_FARM'
    : next.detail === 'QUOTE_TWEET' || next.detail?.startsWith('QUOTE_TWEET')
      ? 'QUOTE_TWEET'
      : next.detail === 'ORIGINAL' || next.detail?.startsWith('ORIGINAL')
        ? 'ORIGINAL'
        : 'ORIGINAL';

  // Preserve post type across reschedules that append `; retry=N`.
  const typeToken = postType;

  logEvent('ORIGINAL_RUN_START', `id=${next.id} time=${formatLocalTime(next.run_at)} type=${typeToken}`);
  logger.info('Firing scheduled original post', { id: next.id, runAt: formatLocalTime(next.run_at), postType: typeToken });

  const result = await fireOnePost(`scheduled-run-${next.id}`, typeToken);
  if (result.ok) {
    markRunFired(next.id, typeToken);
    logEvent('ORIGINAL_RUN_FIRED', `id=${next.id} time=${formatLocalTime(next.run_at)} type=${typeToken}`);
    return;
  }

  if (result.skipped) {
    markRunSkipped(next.id, result.error ?? 'skipped');
    return;
  }

  const retries = retryCountFromDetail(next.detail);
  const msg = (result.error ?? 'unknown error').slice(0, 240);
  if (retries < MAX_TRANSIENT_RETRIES) {
    const nextAt = Math.floor(Date.now() / 1000) + RESCHEDULE_DELAY_SEC;
    rescheduleRun(next.id, nextAt, withRetryDetail(`${typeToken}; transient: ${msg}`, retries + 1));
    logEvent('ORIGINAL_POST_RESCHEDULED', `id=${next.id} retry=${retries + 1} err=${msg}`);
    logger.warn('Original post failed — rescheduled', { id: next.id, retries: retries + 1, err: msg });
  } else {
    markRunError(next.id, msg);
    logEvent('ORIGINAL_POST_ERROR', msg);
  }
}

async function fireOnePost(trigger: string, postType: OriginalPostType = 'ORIGINAL'): Promise<{ ok: boolean; id?: string; error?: string; skipped?: boolean }> {
  _posting = true;
  logEvent('ORIGINAL_POST_START', `${trigger} type=${postType}`);
  let draftId: string | null = null;

  try {
    // 1. Generate
    let quoteCandidate: QuoteTweetCandidate | null = null;
    if (postType === 'QUOTE_TWEET') {
      quoteCandidate = selectQuoteTweetCandidate();
      if (!quoteCandidate) {
        logEvent('QUOTE_TWEET_SKIPPED', 'no eligible recent source tweet');
        return { ok: false, skipped: true, error: 'no eligible quote-tweet source' };
      }
    }

    const recentContents = listRecentOriginalPostContents(25);
    const distinct = await generateDistinct({
      existingTexts: recentContents,
      generate: (attempt) => {
        const options = attempt > 1 ? { avoidTexts: recentContents } : {};
        if (postType === 'ENGAGEMENT_FARM') return generateEngagementFarmPost(options);
        if (postType === 'QUOTE_TWEET') {
          return generateQuoteTweetPost(quoteCandidate!.post, options);
        }
        return generateOriginalPost(options);
      },
      getText: (value) => value.content,
      onDuplicate: (_value, attempt) => {
        logEvent('DUPLICATE_ORIGINAL_REJECTED', `type=${postType} attempt=${attempt}`);
        logger.warn('Generated original post matched recent history', { postType, attempt });
      },
    });
    if (!distinct.value) {
      logEvent('ORIGINAL_POST_SKIPPED_DUPLICATE', `type=${postType}; two duplicate drafts`);
      return { ok: false, skipped: true, error: 'duplicate drafts (skipped)' };
    }
    const generated = distinct.value;

    // 2. Persist draft
    const post = insertOriginalPost({
      content: generated.content,
      language: generated.language,
      topic: generated.topic,
      postType,
      researchContext: generated.researchContext,
      threadParts: generated.parts,
      quotedTweet: quoteCandidate ? {
        id: quoteCandidate.post.tweet_id,
        url: quoteCandidate.post.tweet_url,
        authorHandle: quoteCandidate.post.author_handle,
      } : undefined,
    });
    draftId = post.id;

    logEvent(
      'ORIGINAL_POST_GENERATED',
      `topic=${generated.topic} lang=${generated.language} parts=${generated.parts.length}`,
      post.id,
    );

    // 3. Post to X
    const posted = quoteCandidate
      ? await postQuoteTweet(generated.content, quoteCandidate.post.tweet_url)
      : await postTweetThread(generated.parts);
    const tweetIds = 'tweetIds' in posted ? posted.tweetIds : [posted.tweetId];
    const tweetUrls = 'tweetUrls' in posted ? posted.tweetUrls : [posted.tweetUrl];

    // 4. Mark posted
    markOriginalPostPosted(post.id, tweetIds, tweetUrls);
    logEvent(
      'ORIGINAL_POST_POSTED',
      `${tweetUrls[0] ?? '(no url)'} parts=${generated.parts.length}`,
      post.id,
    );
    logger.info('Original post live', { postId: post.id, tweetIds, tweetUrls });

    return { ok: true, id: post.id };
  } catch (err) {
    if (draftId) markOriginalPostError(draftId);
    if (err instanceof EmptyReplyError) {
      logger.warn('Original post: empty reply from Groq — skipping, waiting for next slot', { trigger });
      logEvent('ORIGINAL_POST_SKIPPED_EMPTY', 'empty reply, skipped');
      return { ok: false, skipped: true, error: 'empty reply (skipped)' };
    }
    logger.error('Original post failed', { trigger, err: String(err) });
    logEvent('ORIGINAL_POST_ERROR', String(err));
    return { ok: false, error: String(err) };
  } finally {
    _posting = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateRandomSlots(dateKey: string): Array<{ ts: number; postType: OriginalPostType }> {
  const n = getIntSetting('original_posts_per_day', 7, 1, 12);
  const quoteTweetCount = n >= 3 ? 1 : 0;
  const engagementFarmCount = Math.min(2, Math.max(0, n - quoteTweetCount - 1));

  // Default at 7/day: 2 engagement farms, 1 quote tweet, 4 originals.
  const types: OriginalPostType[] = [
    ...Array(engagementFarmCount).fill('ENGAGEMENT_FARM'),
    ...Array(quoteTweetCount).fill('QUOTE_TWEET'),
    ...Array(n - engagementFarmCount - quoteTweetCount).fill('ORIGINAL'),
  ];
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [types[i], types[j]] = [types[j], types[i]];
  }

  return generateWeightedSlots(n, dateKey).map((ts, i) => ({ ts, postType: types[i] ?? 'ORIGINAL' }));
}
