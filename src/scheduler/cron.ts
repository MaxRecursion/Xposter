import cron, { ScheduledTask } from 'node-cron';
import { ingestTimeline } from '../browser/ingestion.js';
import { DetectedLanguage, filterPost } from '../pipeline/filter.js';
import { ScoredPost, scorePost, rankCandidates } from '../pipeline/scorer.js';
import { generateReply } from '../pipeline/generator.js';
import { sendApprovalNotification } from '../notifications/ntfy.js';
import {
  upsertPost, updatePostLanguage, updatePostScore, updateGeneratedReply,
  updatePostStatus, getPost, getPostsByStatus, getSetting,
  logEvent, expireOldPending,
  Post,
} from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';

let _task: ScheduledTask | null = null;
let _running = false;

export function startScheduler(): void {
  const expr = process.env.INGEST_CRON ?? '0 9,12,15,18,21 * * *';
  logger.info('Starting scheduler', { cron: expr });

  _task = cron.schedule(expr, async () => {
    await runPipeline();
  });

  // Also run an expiry checker every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    const expired = expireOldPending();
    if (expired > 0) logger.info(`Expired ${expired} stale pending posts`);
  });
}

export function stopScheduler(): void {
  _task?.stop();
  _task = null;
  logger.info('Scheduler stopped');
}

/** Manually trigger a pipeline run (also called by the web UI). */
export async function runPipeline(): Promise<{ ingested: number; candidates: number }> {
  if (_running) {
    logger.warn('Pipeline already running — skipping overlapping run');
    return { ingested: 0, candidates: 0 };
  }

  const systemRunning = getSetting('system_running', 'true') === 'true';
  if (!systemRunning) {
    logger.info('System paused — skipping pipeline run');
    return { ingested: 0, candidates: 0 };
  }

  _running = true;
  logEvent('PIPELINE_START');

  try {
    // 1. Ingest
    const rawTweets = await ingestTimeline(60);
    logEvent('INGESTION_COMPLETE', `${rawTweets.length} raw tweets`);

    // 2. Upsert new posts
    let ingested = 0;
    const newPosts: Post[] = [];
    for (const tweet of rawTweets) {
      const post = upsertPost(tweet);
      if (post) { ingested++; newPosts.push(post); }
    }

    logger.info(`Ingested ${ingested} new posts (${rawTweets.length - ingested} duplicates skipped)`);

    // 3. Filter
    const extraKw = getSetting('topic_keywords', '').split(',').filter(Boolean);
    const filtered: Array<{ post: Post; lang: DetectedLanguage }> = [];
    const filterResults = new Map<string, { post: Post; lang: DetectedLanguage; passed: boolean }>();
    for (const post of newPosts) {
      const result = filterPost(post.text, extraKw);
      filterResults.set(post.id, { post, lang: result.language, passed: result.pass });
      if (result.pass) {
        updatePostLanguage(post.id, result.language);
        filtered.push({ post, lang: result.language });
      } else {
        updatePostStatus(post.id, 'SKIPPED');
      }
    }

    logger.info(`Filter: ${filtered.length}/${ingested} posts passed`);
    logEvent('FILTER_COMPLETE', `${filtered.length} passed`);

    // 4. Score
    const minScore = parseFloat(getSetting('min_score', '40'));
    const scoredList: ScoredPost[] = [];
    const scoredAboveThreshold: ScoredPost[] = [];
    for (const { post } of filtered) {
      const filterResult = filterResults.get(post.id);
      const scored = scorePost({ ...post, language: filterResult?.lang ?? post.language });
      updatePostScore(post.id, scored.score, scored.breakdown as any);
      scoredList.push(scored);
      if (scored.score >= minScore) scoredAboveThreshold.push(scored);
    }

    const ranked = rankCandidates(scoredAboveThreshold);
    const configuredMaxCandidates = parseInt(getSetting('max_candidates_per_run', '3'), 10);
    const maxCandidates = Number.isFinite(configuredMaxCandidates)
      ? Math.max(1, configuredMaxCandidates)
      : 1;
    let topCandidates = ranked.slice(0, maxCandidates);

    if (topCandidates.length === 0 && newPosts.length > 0) {
      const fallbackCandidates = rankCandidates(newPosts.map((post) => {
        const filterResult = filterResults.get(post.id);
        return scorePost({ ...post, language: filterResult?.lang ?? post.language });
      }));
      const fallback = fallbackCandidates[0];

      if (fallback) {
        const fallbackSource = filterResults.get(fallback.id);
        const fallbackPost = fallbackSource?.post ?? newPosts.find((post) => post.id === fallback.id);
        if (fallbackPost) {
          updatePostLanguage(fallbackPost.id, fallbackSource?.lang ?? fallbackPost.language);
          updatePostScore(fallbackPost.id, fallback.score, fallback.breakdown as any);
        }
        topCandidates = [fallback];
        logEvent('FALLBACK_CANDIDATE_SELECTED', `score=${fallback.score} min=${minScore}`, fallback.id);
        logger.warn('No candidates met filters/score threshold; selected fallback candidate', {
          postId: fallback.id,
          score: fallback.score,
          minScore,
          filterPassed: fallbackSource?.passed ?? false,
        });
      }
    }

    logger.info(`Scored: ${scoredAboveThreshold.length} above threshold, taking top ${topCandidates.length}`);
    logEvent('SCORE_COMPLETE', `${topCandidates.length} candidates selected`);

    // 5. Generate replies + notify (staggered to avoid rate limits)
    let notified = 0;
    for (const candidate of topCandidates) {
      try {
        const post = getPost(candidate.id);
        if (!post) continue;

        updatePostStatus(post.id, 'GENERATING');

        const reply = await generateReply(post);
        updateGeneratedReply(post.id, reply);

        // Refetch with updated data
        const updatedPosts = getPostsByStatus('PENDING_APPROVAL');
        const updated = updatedPosts.find((p) => p.id === candidate.id);
        if (updated) {
          // Notification failure must NOT move the post to ERROR — the reply
          // is still pending approval and visible in the dashboard.
          const result = await sendApprovalNotification(updated);
          if (result.ok) {
            logEvent('NOTIFICATION_SENT', `topic=${result.topic}`, post.id);
          } else {
            logEvent('NOTIFICATION_FAILED', result.error ?? 'unknown error', post.id);
            logger.warn('ntfy notification failed but post remains pending approval', {
              postId: post.id, error: result.error,
            });
          }
          notified++;
        }

        // Stagger notifications to avoid being spammy
        if (notified < topCandidates.length) {
          await delay(randomBetween(2000, 5000));
        }
      } catch (err) {
        logger.error('Error processing candidate', { id: candidate.id, err });
        updatePostStatus(candidate.id, 'ERROR');
        logEvent('CANDIDATE_ERROR', String(err), candidate.id);
      }
    }

    logEvent('PIPELINE_COMPLETE', `ingested=${ingested} candidates=${notified}`);
    logger.info('Pipeline complete', { ingested, candidates: notified });
    return { ingested, candidates: notified };
  } catch (err) {
    logger.error('Pipeline failed', { err });
    logEvent('PIPELINE_ERROR', String(err));
    throw err;
  } finally {
    _running = false;
  }
}

export function isPipelineRunning(): boolean {
  return _running;
}
