/**
 * Image posts scheduler — generates and posts one AI lifestyle image per day
 * at a random time in the evening window (default 6 PM – 10 PM).
 */
import crypto from 'crypto';
import { getDb } from '../storage/db.js';
import { getBooleanSetting, getIntSetting } from '../storage/settings.js';
import { logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { todayDateKey } from './daily_plan.js';
import { generateImage, pickScene } from '../images/generator.js';
import { generateCaption } from '../images/captions.js';
import { postImageTweet } from '../browser/compose.js';

const TICK_INTERVAL_MS = 60_000; // check every minute
let _tickHandle: NodeJS.Timeout | null = null;
let _posting = false;

// ── Public API ────────────────────────────────────────────────────────────────

export function startImagePostScheduler(): void {
  if (_tickHandle) return;
  ensureTodayImagePlan();
  _tickHandle = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
  void tick();
  logger.info('Image post scheduler started (1 image/day, evening window)');
}

export function stopImagePostScheduler(): void {
  if (_tickHandle) { clearInterval(_tickHandle); _tickHandle = null; }
}

// ── Scheduler plan ────────────────────────────────────────────────────────────

interface ImagePlan {
  id: string;
  date_key: string;
  scheduled_at: number;    // unix seconds
  fired: number;           // 0 or 1
}

function ensureTodayImagePlan(): ImagePlan {
  const db = getDb();
  const dateKey = todayDateKey();

  db.exec(`
    CREATE TABLE IF NOT EXISTS image_post_schedule (
      id           TEXT PRIMARY KEY,
      date_key     TEXT NOT NULL UNIQUE,
      scheduled_at INTEGER NOT NULL,
      fired        INTEGER NOT NULL DEFAULT 0
    );
  `);

  const existing = db.prepare(
    `SELECT * FROM image_post_schedule WHERE date_key = ?`,
  ).get(dateKey) as ImagePlan | undefined;

  if (existing) return existing;

  const startHour = getIntSetting('image_evening_start_hour', 18, 0, 23);
  const endHour   = getIntSetting('image_evening_end_hour',   22, 1, 24);
  const clampedEnd = endHour <= startHour ? startHour + 1 : endHour;

  const [y, m, d] = dateKey.split('-').map(Number);
  const windowStartMs = new Date(y, m - 1, d, startHour, 0, 0).getTime();
  const windowEndMs   = new Date(y, m - 1, d, clampedEnd, 0, 0).getTime();
  const randomMs      = windowStartMs + Math.random() * (windowEndMs - windowStartMs);
  const scheduledAt   = Math.floor(randomMs / 1000);

  const plan: ImagePlan = {
    id: crypto.randomUUID(),
    date_key: dateKey,
    scheduled_at: scheduledAt,
    fired: 0,
  };

  db.prepare(
    `INSERT OR IGNORE INTO image_post_schedule (id, date_key, scheduled_at, fired) VALUES (?, ?, ?, 0)`,
  ).run(plan.id, plan.date_key, plan.scheduled_at);

  const scheduledTime = new Date(scheduledAt * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  logEvent('IMAGE_SCHEDULE_CREATED', `image post scheduled for ${scheduledTime}`);
  logger.info('Image post scheduled', { date: dateKey, time: scheduledTime });

  return plan;
}

// ── Tick ──────────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (!getBooleanSetting('image_posts_enabled', true)) return;
  if (!getBooleanSetting('system_running', true)) return;
  if (_posting) return;

  const plan = ensureTodayImagePlan();
  if (plan.fired) return;

  const now = Math.floor(Date.now() / 1000);
  if (now < plan.scheduled_at) return;

  // Mark fired immediately to prevent double-run
  getDb().prepare(`UPDATE image_post_schedule SET fired = 1 WHERE id = ?`).run(plan.id);

  _posting = true;
  logEvent('IMAGE_POST_START', `date=${plan.date_key}`);

  try {
    // 1. Pick scene + generate image
    const scene = pickScene();
    const generated = await generateImage(scene);

    // 2. Generate caption
    const recentCaptions = getRecentCaptions(5);
    const caption = await generateCaption(generated.scene, recentCaptions);

    // 3. Insert pending record
    const db = getDb();
    const postId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO image_posts (id, scene_id, prompt, revised_prompt, caption, file_path, model, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'POSTING')
    `).run(
      postId,
      generated.scene.id,
      generated.prompt,
      generated.revisedPrompt ?? null,
      caption,
      generated.filePath,
      generated.model,
    );

    logEvent('IMAGE_POST_GENERATED', `scene=${scene.id} caption="${caption.slice(0, 50)}"`, postId);

    // 4. Post to X
    const result = await postImageTweet(generated.filePath, caption);

    // 5. Mark posted
    db.prepare(`
      UPDATE image_posts
      SET status = 'POSTED', tweet_id = ?, tweet_url = ?, posted_at = unixepoch()
      WHERE id = ?
    `).run(result.tweetId ?? null, result.tweetUrl ?? null, postId);

    logEvent('IMAGE_POST_POSTED', `scene=${scene.id} url=${result.tweetUrl ?? 'unknown'}`, postId);
    logger.info('Image post live', { postId, scene: scene.id, tweetUrl: result.tweetUrl });
  } catch (err) {
    logger.error('Image post failed', { err: String(err) });
    logEvent('IMAGE_POST_ERROR', String(err));
    // Un-fire the plan so it can retry after restart if it was a transient error
    getDb().prepare(`UPDATE image_post_schedule SET fired = 0 WHERE id = ?`).run(plan.id);
  } finally {
    _posting = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getRecentCaptions(limit: number): string[] {
  try {
    const rows = getDb().prepare(
      `SELECT caption FROM image_posts WHERE status = 'POSTED' ORDER BY posted_at DESC LIMIT ?`,
    ).all(limit) as Array<{ caption: string }>;
    return rows.map((r) => r.caption);
  } catch {
    return [];
  }
}

/** For the API / dashboard: today's scheduled image post time. */
export function getTodayImageSchedule(): { scheduledAt: number; fired: boolean } | null {
  try {
    const row = getDb().prepare(
      `SELECT scheduled_at, fired FROM image_post_schedule WHERE date_key = ?`,
    ).get(todayDateKey()) as { scheduled_at: number; fired: number } | undefined;
    if (!row) return null;
    return { scheduledAt: row.scheduled_at, fired: row.fired === 1 };
  } catch {
    return null;
  }
}
