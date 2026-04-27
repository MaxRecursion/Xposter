import {
  getDuePendingRuns, getScheduledRunsForDate, getUpcomingRuns,
  insertScheduledRun, markRunFired, ScheduledRun,
} from '../storage/accounts.js';
import {
  insertOriginalPost, markOriginalPostPosted, markOriginalPostError,
  getPostsNeedingImpressionSync, insertImpression,
} from '../storage/original_posts.js';
import { generateOriginalPost } from '../pipeline/original_post_generator.js';
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

  logger.info('Original post scheduler started (5x/day + 2h impression sync)');
}

export function stopOriginalPostScheduler(): void {
  if (_tickHandle) { clearInterval(_tickHandle); _tickHandle = null; }
  if (_syncHandle) { clearInterval(_syncHandle); _syncHandle = null; }
}

/** Public handle for the API "trigger now" endpoint. */
export async function triggerOriginalPost(): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (_posting) return { ok: false, error: 'Already posting — try again in a moment' };
  return fireOnePost('manual-trigger');
}

export function ensureTodayOriginalPlan(): ScheduledRun[] {
  const dateKey = todayDateKey();
  const existing = getScheduledRunsForDate(dateKey, KIND);
  if (existing.length > 0) return existing;

  const times = generateRandomTimes(dateKey);
  for (const ts of times) insertScheduledRun(dateKey, ts, KIND);

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
  markRunFired(next.id, 'fired by original post scheduler');
  logEvent('ORIGINAL_RUN_FIRED', `id=${next.id} time=${fmt(next.run_at)}`);
  logger.info('Firing scheduled original post', { id: next.id, runAt: fmt(next.run_at) });

  await fireOnePost(`scheduled-run-${next.id}`);
}

async function fireOnePost(trigger: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  _posting = true;
  logEvent('ORIGINAL_POST_START', trigger);

  try {
    // 1. Generate
    const generated = await generateOriginalPost();

    // 2. Persist draft
    const post = insertOriginalPost({
      content: generated.content,
      language: generated.language,
      topic: generated.topic,
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

function generateRandomTimes(dateKey: string): number[] {
  const n = clamp(parseInt(getSetting('original_posts_per_day', '5'), 10), 1, 12);
  const startHour = clamp(parseInt(getSetting('active_window_start_hour', '9'), 10), 0, 23);
  const endHourRaw = clamp(parseInt(getSetting('active_window_end_hour', '22'), 10), 1, 24);
  const endHour = endHourRaw <= startHour ? startHour + 1 : endHourRaw;

  const [y, m, d] = dateKey.split('-').map(Number);
  const startMs = new Date(y, m - 1, d, startHour).getTime();
  const endMs = new Date(y, m - 1, d, endHour).getTime();
  const totalMin = Math.floor((endMs - startMs) / 60_000);
  if (totalMin <= 0) return [];

  const slotMin = Math.floor(totalMin / n);
  const picks: number[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  for (let i = 0; i < n; i++) {
    const slotStart = i * slotMin;
    const slotEnd = (i + 1) * slotMin;
    const offsetMin = slotStart + Math.floor(Math.random() * Math.max(1, slotEnd - slotStart));
    const ts = Math.floor((startMs + offsetMin * 60_000) / 1000);
    if (ts > nowSec + 60) picks.push(ts);
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
