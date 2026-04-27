import { ingestTimeline } from '../browser/ingestion.js';
import { DetectedLanguage, filterPost } from '../pipeline/filter.js';
import { ScoredPost, scorePost, rankCandidates } from '../pipeline/scorer.js';
import { generateReply } from '../pipeline/generator.js';
import { classifyAccount } from '../pipeline/classifier.js';
import { sendApprovalNotification } from '../notifications/ntfy.js';
import {
  upsertPost, updatePostLanguage, updatePostScore, updateGeneratedReply,
  updatePostStatus, getPost, getPostsByStatus, getSetting,
  logEvent, expireOldPending,
  Post,
} from '../storage/queries.js';
import { upsertAccountSeen } from '../storage/accounts.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';
import {
  configureRandomRuns, startRandomScheduler, stopRandomScheduler,
} from './random_runs.js';
import { startFollowerSync, stopFollowerSync } from './follower_sync.js';

let _running = false;

export function startScheduler(): void {
  // The pipeline cron is now driven by random_runs.ts.
  configureRandomRuns(async () => { await runPipeline(); });
  startRandomScheduler();
  startFollowerSync();

  // Expiry sweep: every 5 minutes
  setInterval(() => {
    const expired = expireOldPending();
    if (expired > 0) logger.info(`Expired ${expired} stale pending posts`);
  }, 5 * 60_000);

  logger.info('Scheduler started (randomized 5x daily + follower sync)');
}

export function stopScheduler(): void {
  stopRandomScheduler();
  stopFollowerSync();
  logger.info('Scheduler stopped');
}

/** Manually trigger a pipeline run (also called by the random scheduler). */
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

    // 2. Upsert new posts + register authors as seen accounts
    let ingested = 0;
    const newPosts: Post[] = [];
    for (const tweet of rawTweets) {
      const post = upsertPost(tweet);
      if (post) {
        ingested++;
        newPosts.push(post);
        upsertAccountSeen(tweet.author_handle, tweet.author_name);
      }
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
    const scoredAboveThreshold: ScoredPost[] = [];
    for (const { post, lang } of filtered) {
      const scored = scorePost({ ...post, language: lang });
      updatePostScore(post.id, scored.score, scored.breakdown as any);
      if (scored.score >= minScore) scoredAboveThreshold.push(scored);
    }

    const ranked = rankCandidates(scoredAboveThreshold);
    const maxCandidates = Math.max(1, parseInt(getSetting('max_candidates_per_run', '3'), 10) || 3);
    let topCandidates = ranked.slice(0, maxCandidates);

    // Fallback: if nothing meets the threshold, take the single best post anyway
    if (topCandidates.length === 0 && newPosts.length > 0) {
      const allScored = newPosts.map((post) => {
        const lang = filterResults.get(post.id)?.lang ?? (post.language as DetectedLanguage);
        return scorePost({ ...post, language: lang });
      });
      const fallback = rankCandidates(allScored)[0];
      if (fallback) {
        const fb = filterResults.get(fallback.id);
        if (fb) {
          updatePostLanguage(fb.post.id, fb.lang);
          updatePostScore(fb.post.id, fallback.score, fallback.breakdown as any);
        }
        topCandidates = [fallback];
        logEvent('FALLBACK_CANDIDATE_SELECTED', `score=${fallback.score} min=${minScore}`, fallback.id);
      }
    }

    logger.info(`Scored: ${scoredAboveThreshold.length} above threshold, taking top ${topCandidates.length}`);
    logEvent('SCORE_COMPLETE', `${topCandidates.length} candidates selected`);

    // 5. Classify authors → generate replies → notify
    const blocklist = getSetting('blocklist_classifications', 'BOT,SPAM,BRAND_PROMO')
      .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

    let notified = 0;
    for (const candidate of topCandidates) {
      try {
        const post = getPost(candidate.id);
        if (!post) continue;

        // Classify (cached). On first encounter this fetches the profile via Playwright.
        let account = null;
        try {
          account = await classifyAccount(post.author_handle, post.author_name, {
            fetchProfileIfMissing: true,
          });
          logEvent(
            'AUTHOR_CLASSIFIED',
            `${post.author_handle} → ${account.classification ?? 'UNKNOWN'} (${(account.classification_confidence * 100).toFixed(0)}%)`,
            post.id,
          );
        } catch (err) {
          logger.warn('Classification failed; continuing with UNKNOWN', { err: String(err) });
        }

        // Skip blocklisted classifications outright
        if (account?.classification && blocklist.includes(account.classification)) {
          updatePostStatus(post.id, 'SKIPPED');
          logEvent('SKIPPED_BY_CLASSIFICATION', `${account.classification} on blocklist`, post.id);
          continue;
        }

        updatePostStatus(post.id, 'GENERATING');
        const reply = await generateReply(post, account);
        updateGeneratedReply(post.id, reply);

        const updatedPosts = getPostsByStatus('PENDING_APPROVAL');
        const updated = updatedPosts.find((p) => p.id === candidate.id);
        if (updated) {
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
