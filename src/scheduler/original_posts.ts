import {
  getDuePendingRuns, getScheduledRunsForDate, getUpcomingRuns,
  insertScheduledRun, markRunFired, ScheduledRun,
} from '../storage/scheduled_runs.js';
import {
  insertOriginalPost, markOriginalPostPosted, markOriginalPostError,
  getPostsNeedingImpressionSync, insertImpression,
} from '../storage/original_posts.js';
import { generateOriginalPost, generateEngagementFarmPost } from '../pipeline/original_post_generator.js';
import { EmptyReplyError } from '../pipeline/errors.js';
import type { OriginalPostType } from '../storage/original_posts.js';
import { postOriginalTweet } from '../browser/compose.js';
import { scrapeEngagement } from '../browser/impressions.js';
import { logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';
import { formatLocalTime, generateWeightedSlots, todayDateKey } from './daily_plan.js';
import { getBooleanSetting, getIntSetting } from '../storage/settings.js';

const KIND = 'ORIGINAL_POST';
const TICK_INTERVAL_MS = 60_000;
const IMPRESSION_SYNC_MS = 2 * 60 * 60 * 1000; // 2 hours

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

  logger.info('Original post scheduler started (7x/day: 5 original + 2 engagement farm, 2h impression sync)');
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
  const postType: OriginalPostType = next.detail === 'ENGAGEMENT_FARM' ? 'ENGAGEMENT_FARM' : 'ORIGINAL';
  markRunFired(next.id, 'fired by original post scheduler');
  logEvent('ORIGINAL_RUN_FIRED', `id=${next.id} time=${formatLocalTime(next.run_at)} type=${postType}`);
  logger.info('Firing scheduled original post', { id: next.id, runAt: formatLocalTime(next.run_at), postType });

  await fireOnePost(`scheduled-run-${next.id}`, postType);
}

async function fireOnePost(trigger: string, postType: OriginalPostType = 'ORIGINAL'): Promise<{ ok: boolean; id?: string; error?: string }> {
  _posting = true;
  logEvent('ORIGINAL_POST_START', `${trigger} type=${postType}`);

  try {
    // 1. Generate
    const generated = postType === 'ENGAGEMENT_FARM'
      ? await generateEngagementFarmPost()
      : await generateOriginalPost();

    // 2. Persist draft
    const post = insertOriginalPost({
      content: generated.content,
      language: generated.language,
      topic: generated.topic,
      postType,
      researchContext: generated.researchContext,
    });

    logEvent('ORIGINAL_POST_GENERATED', `topic=${generated.topic} lang=${generated.language}`, post.id);

    // 3. Post to X
    const { tweetId, tweetUrl } = await postOriginalTweet(generated.content);

    // 4. Mark posted
    markOriginalPostPosted(post.id, tweetId, tweetUrl);
    logEvent('ORIGINAL_POST_POSTED', tweetUrl ?? '(no url)', post.id);
    logger.info('Original post live', { postId: post.id, tweetId, tweetUrl });

    return { ok: true, id: post.id };
  } catch (err) {
    if (err instanceof EmptyReplyError) {
      logger.warn('Original post: empty reply from Groq — skipping, waiting for next slot', { trigger });
      logEvent('ORIGINAL_POST_SKIPPED_EMPTY', 'empty reply, skipped');
      return { ok: false, error: 'empty reply (skipped)' };
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
  const engagementFarmCount = Math.min(2, n);

  // Build shuffled post type array: 2 ENGAGEMENT_FARM, rest ORIGINAL
  const types: OriginalPostType[] = [
    ...Array(engagementFarmCount).fill('ENGAGEMENT_FARM'),
    ...Array(n - engagementFarmCount).fill('ORIGINAL'),
  ];
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [types[i], types[j]] = [types[j], types[i]];
  }

  return generateWeightedSlots(n, dateKey).map((ts, i) => ({ ts, postType: types[i] ?? 'ORIGINAL' }));
}
