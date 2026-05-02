import {
  getDuePendingRuns, getScheduledRunsForDate, getUpcomingRuns,
  insertScheduledRun, markRunFired, ScheduledRun,
} from '../storage/accounts.js';
import {
  insertOriginalPost, markOriginalPostPosted, markOriginalPostError,
  getPostsNeedingImpressionSync, insertImpression,
} from '../storage/original_posts.js';
import { generateOriginalPost, generateEngagementFarmPost } from '../pipeline/original_post_generator.js';
import type { OriginalPostType } from '../storage/original_posts.js';
import { postOriginalTweet } from '../browser/compose.js';
import { scrapeEngagement } from '../browser/impressions.js';
import { getSetting, logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';

const KIND = 'ORIGINAL_POST';
const TICK_INTERVAL_MS = 60_000;
const IMPRESSION_SYNC_MS = 2 * 60 * 60 * 1000; // 2 hours

let _tickHandle: NodeJS.Timeout | null = null;
let _syncHandle: NodeJS.Timeout | null = null;
let _posting = false;

// ── Public API ────────────────────────────────────────────────────────────────

export function startOriginalPostScheduler(): void {
  ensureTodayOriginalPlan();
  if (_tickHandle) return;

  _tickHandle = setInterval(tick, TICK_INTERVAL_MS);
  void tick(); // check immediately on boot

  // Impression sync: first run 10 min after boot (let things settle), then every 2h
  setTimeout(() => {
    void runImpressionSync();
    _syncHandle = setInterval(() => { void runImpressionSync(); }, IMPRESSION_SYNC_MS);
  }, 10 * 60_000);

  logger.info('Original post scheduler started (7x/day: 5 original + 2 engagement farm, 2h impression sync)');
}

export function stopOriginalPostScheduler(): void {
  if (_tickHandle) { clearInterval(_tickHandle); _tickHandle = null; }
  if (_syncHandle) { clearInterval(_syncHandle); _syncHandle = null; }
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
    `${created.length} posts at: ${created.map((r) => fmt(r.run_at)).join(', ')}`,
  );
  logger.info("Today's original post plan created", {
    date: dateKey,
    times: created.map((r) => fmt(r.run_at)),
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

  if (getSetting('system_running', 'true') !== 'true') return;
  if (_posting) return;

  const due = getDuePendingRuns(Math.floor(Date.now() / 1000), KIND);
  if (due.length === 0) return;

  const next = due[0];
  const postType: OriginalPostType = next.detail === 'ENGAGEMENT_FARM' ? 'ENGAGEMENT_FARM' : 'ORIGINAL';
  markRunFired(next.id, 'fired by original post scheduler');
  logEvent('ORIGINAL_RUN_FIRED', `id=${next.id} time=${fmt(next.run_at)} type=${postType}`);
  logger.info('Firing scheduled original post', { id: next.id, runAt: fmt(next.run_at), postType });

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
    logger.error('Original post failed', { trigger, err: String(err) });
    logEvent('ORIGINAL_POST_ERROR', String(err));
    return { ok: false, error: String(err) };
  } finally {
    _posting = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateRandomSlots(dateKey: string): Array<{ ts: number; postType: OriginalPostType }> {
  const n = clamp(parseInt(getSetting('original_posts_per_day', '7'), 10), 1, 12);
  const engagementFarmCount = Math.min(2, n);
  const startHour = clamp(parseInt(getSetting('active_window_start_hour', '9'), 10), 0, 23);
  const endHourRaw = clamp(parseInt(getSetting('active_window_end_hour', '22'), 10), 1, 24);
  const endHour = endHourRaw <= startHour ? startHour + 1 : endHourRaw;

  const [y, m, d] = dateKey.split('-').map(Number);
  const startMs = new Date(y, m - 1, d, startHour).getTime();
  const endMs = new Date(y, m - 1, d, endHour).getTime();
  const totalMin = Math.floor((endMs - startMs) / 60_000);
  if (totalMin <= 0) return [];

  // Build shuffled post type array: 2 ENGAGEMENT_FARM, rest ORIGINAL
  const types: OriginalPostType[] = [
    ...Array(engagementFarmCount).fill('ENGAGEMENT_FARM'),
    ...Array(n - engagementFarmCount).fill('ORIGINAL'),
  ];
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [types[i], types[j]] = [types[j], types[i]];
  }

  const slotMin = Math.floor(totalMin / n);
  const picks: Array<{ ts: number; postType: OriginalPostType }> = [];
  const nowSec = Math.floor(Date.now() / 1000);

  for (let i = 0; i < n; i++) {
    const slotStart = i * slotMin;
    const slotEnd = (i + 1) * slotMin;
    const offsetMin = slotStart + Math.floor(Math.random() * Math.max(1, slotEnd - slotStart));
    const ts = Math.floor((startMs + offsetMin * 60_000) / 1000);
    if (ts > nowSec + 60) picks.push({ ts, postType: types[i] });
  }
  return picks;
}

function todayDateKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmt(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}
