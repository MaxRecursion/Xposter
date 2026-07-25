/**
 * Image post scheduler — generates and posts AI lifestyle images during the
 * evening window.
 *
 * Runs on the shared `scheduled_runs` table (kind='IMAGE_POST') like the
 * original-post scheduler, rather than the bespoke `image_post_schedule` table
 * it used to own. That table's UNIQUE(date_key) constraint was what pinned this
 * to exactly one post per day and made `image_posts_per_day` dead config.
 *
 * Every generated image passes a vision QA gate before it is posted. If the
 * gate rejects every attempt, nothing is posted — a visibly malformed image is
 * worse for the account than no image at all.
 */
import {
  getDuePendingRuns, getScheduledRunsForDate, insertScheduledRun, markRunFired,
} from '../storage/scheduled_runs.js';
import { getBooleanSetting, getIntSetting } from '../storage/settings.js';
import { logEvent } from '../storage/queries.js';
import {
  getRecentCaptions, insertImagePost, markImagePostError, markImagePostPosted,
  setImagePostStatus, sweepStuckImagePosts,
} from '../storage/image_posts.js';
import { logger } from '../utils/logger.js';
import { formatLocalTime, generateWeightedSlots, getActiveWindow, todayDateKey } from './daily_plan.js';
import {
  buildDetailWithClaude, generateImage, pickSafeScene, pickScene,
  type GeneratedImage, type GenerateImageOptions, type Scene,
} from '../images/generator.js';
import { generateCaption } from '../images/captions.js';
import { isRejected, judgeImage, rejectionReason, type ImageVerdict } from '../images/vision_qa.js';
import { postImageTweet } from '../browser/compose.js';

const KIND = 'IMAGE_POST';
const TICK_INTERVAL_MS = 60_000;

let _tickHandle: NodeJS.Timeout | null = null;
let _posting = false;

// ── Public API ────────────────────────────────────────────────────────────────

export function startImagePostScheduler(): void {
  if (_tickHandle) return;
  sweepStuckImagePosts();
  ensureTodayImagePlan();
  _tickHandle = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
  void tick();
  logger.info('Image post scheduler started (evening window, vision QA gate)');
}

export function stopImagePostScheduler(): void {
  if (_tickHandle) { clearInterval(_tickHandle); _tickHandle = null; }
}

// ── Scheduler plan ────────────────────────────────────────────────────────────

export function ensureTodayImagePlan() {
  const dateKey = todayDateKey();
  const existing = getScheduledRunsForDate(dateKey, KIND);
  if (existing.length > 0) return existing;

  const count = getIntSetting('image_posts_per_day', 1, 0, 4);
  if (count <= 0) return [];

  // Image posts use their own evening window rather than the reply window.
  const window = getActiveWindow(
    dateKey, 'image_evening_start_hour', 'image_evening_end_hour', { start: 18, end: 22 },
  );
  const slots = generateWeightedSlots(count, dateKey, Math.floor(Date.now() / 1000), window);
  for (const ts of slots) insertScheduledRun(dateKey, ts, KIND);

  const created = getScheduledRunsForDate(dateKey, KIND);
  if (created.length > 0) {
    logEvent('IMAGE_SCHEDULE_CREATED', `${created.length} image post(s) at: ${created.map((r) => formatLocalTime(r.run_at)).join(', ')}`);
    logger.info("Today's image post plan created", { date: dateKey, times: created.map((r) => formatLocalTime(r.run_at)) });
  }
  return created;
}

// ── Tick ──────────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (!getBooleanSetting('image_posts_enabled', true)) return;
  if (!getBooleanSetting('system_running', true)) return;
  if (_posting) return;

  ensureTodayImagePlan();

  const due = getDuePendingRuns(Math.floor(Date.now() / 1000), KIND);
  if (due.length === 0) return;

  const run = due[0];
  markRunFired(run.id);

  _posting = true;
  try {
    await fireOneImagePost();
  } catch (err) {
    logger.error('Image post failed', { err: String(err) });
    logEvent('IMAGE_POST_ERROR', String(err).slice(0, 300));
  } finally {
    _posting = false;
  }
}

/**
 * Generation attempts, each de-risking the composition further.
 *
 * A plain reroll is a weak response to these failures — they're systematic
 * (the model cannot draw hands, and it renders faces it was told to omit), not
 * random. So each retry also removes whatever the model keeps getting wrong:
 * first force a silhouette with hidden hands, then drop the person entirely.
 */
function attemptOptions(attempt: number, scene: Scene): { scene: Scene; options: GenerateImageOptions } {
  if (attempt === 1) return { scene, options: {} };
  if (attempt === 2) return { scene, options: { framing: 'silhouette', handState: 'hidden' } };
  return { scene: pickSafeScene(), options: {} };
}

async function fireOneImagePost(): Promise<void> {
  const baseScene = pickScene();
  const maxAttempts = getIntSetting('image_qa_max_attempts', 3, 1, 5);

  logEvent('IMAGE_POST_START', `scene=${baseScene.id}`);

  // The detail sentence is scene-specific, so it's reused across retries of the
  // same scene and regenerated only when the retry ladder swaps the scene out.
  let detail = await buildDetailWithClaude(baseScene);
  let detailSceneId = baseScene.id;

  let best: { image: GeneratedImage; verdict: ImageVerdict } | null = null;
  let accepted: { image: GeneratedImage; verdict: ImageVerdict | null } | null = null;
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsUsed = attempt;
    const { scene, options } = attemptOptions(attempt, baseScene);

    if (scene.id !== detailSceneId) {
      detail = await buildDetailWithClaude(scene);
      detailSceneId = scene.id;
    }

    const image = await generateImage(scene, { ...options, detail });
    const verdict = await judgeImage(image.filePath);

    // No verdict means the gate could not run. Fail open and post — failing
    // closed would silently kill the feature if the CLI ever goes missing.
    if (!verdict) {
      logEvent('IMAGE_QA_UNAVAILABLE', `scene=${scene.id} attempt=${attempt}`);
      accepted = { image, verdict: null };
      break;
    }

    if (!isRejected(verdict)) {
      accepted = { image, verdict };
      break;
    }

    logEvent('IMAGE_QA_REJECTED', `scene=${scene.id} attempt=${attempt}/${maxAttempts} reason=${rejectionReason(verdict)}`);
    logger.warn('Image rejected by QA gate', {
      scene: scene.id, attempt, reason: rejectionReason(verdict), notes: verdict.notes,
    });

    if (!best || verdict.score > best.verdict.score) best = { image, verdict };
  }

  if (!accepted) {
    // Every attempt was rejected. Skip today rather than post the least-bad
    // one: a malformed image is negative engagement, and the run stays FIRED so
    // the 60s tick doesn't retry this all evening.
    const reason = best ? rejectionReason(best.verdict) : 'unknown';
    const postId = best ? recordSkipped(best, attemptsUsed, reason) : null;
    logEvent('IMAGE_QA_EXHAUSTED', `attempts=${attemptsUsed} best_reason=${reason}`, postId ?? undefined);
    logger.warn('Image post skipped — QA gate rejected every attempt', { attempts: attemptsUsed, reason });
    return;
  }

  const { image, verdict } = accepted;
  const caption = await generateCaption(image.scene, getRecentCaptions(5));

  const postId = insertImagePost({
    sceneId: image.scene.id,
    prompt: image.prompt,
    revisedPrompt: image.revisedPrompt ?? null,
    caption,
    filePath: image.filePath,
    model: image.model,
    seed: image.seed,
    width: image.width,
    height: image.height,
    qaVerdict: verdict,
    qaAttempts: attemptsUsed,
  });

  logEvent('IMAGE_POST_GENERATED', `scene=${image.scene.id} attempts=${attemptsUsed} caption="${caption.slice(0, 50)}"`, postId);

  try {
    const result = await postImageTweet(image.filePath, caption);
    markImagePostPosted(postId, result.tweetId ?? null, result.tweetUrl ?? null);
    logEvent('IMAGE_POST_POSTED', `scene=${image.scene.id} url=${result.tweetUrl ?? 'unknown'}`, postId);
    logger.info('Image post live', { postId, scene: image.scene.id, tweetUrl: result.tweetUrl });
  } catch (err) {
    // Previously this only logged, leaving the row stuck in POSTING forever.
    markImagePostError(postId, err);
    logEvent('IMAGE_POST_ERROR', String(err).slice(0, 300), postId);
    throw err;
  }
}

/** Persists the best rejected attempt so the failure is inspectable. */
function recordSkipped(
  best: { image: GeneratedImage; verdict: ImageVerdict },
  attempts: number,
  reason: string,
): string {
  const postId = insertImagePost({
    sceneId: best.image.scene.id,
    prompt: best.image.prompt,
    revisedPrompt: best.image.revisedPrompt ?? null,
    caption: '',
    filePath: best.image.filePath,
    model: best.image.model,
    seed: best.image.seed,
    width: best.image.width,
    height: best.image.height,
    qaVerdict: best.verdict,
    qaAttempts: attempts,
  });
  setImagePostStatus(postId, 'SKIPPED', `QA rejected all ${attempts} attempts: ${reason}`);
  return postId;
}
