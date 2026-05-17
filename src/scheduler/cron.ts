import { ingestTimeline } from '../browser/ingestion.js';
import { DetectedLanguage, filterPost } from '../pipeline/filter.js';
import { ScoredPost, scorePost, rankCandidates } from '../pipeline/scorer.js';
import { generateReply } from '../pipeline/generator.js';
import { EmptyReplyError } from '../pipeline/errors.js';
import { classifyAccount } from '../pipeline/classifier.js';
import { sendReplyPostedNotification } from '../notifications/ntfy.js';
import { postReply } from '../browser/posting.js';
import {
  upsertPost, updatePostLanguage, updatePostScore, updateGeneratedReply,
  updatePostStatus, getPost, getSetting,
  logEvent, expireOldPending, markPostAsPosted,
  Post,
} from '../storage/queries.js';
import { recordInteraction, upsertAccountSeen } from '../storage/accounts.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';
import {
  configureRandomRuns, startRandomScheduler, stopRandomScheduler,
} from './random_runs.js';
import { startFollowerSync, stopFollowerSync } from './follower_sync.js';
import { startOriginalPostScheduler, stopOriginalPostScheduler } from './original_posts.js';
import { startAudienceSync, stopAudienceSync } from './audience_sync.js';
import { startAgentWatcher, stopAgentWatcher } from '../agent/watcher.js';
import { isContextEnabled, getContextStore } from '../context/enrich.js';
import { buildContextSources } from '../context/sources/index.js';
import { startContextIngest, stopContextIngest } from '../context/ingest/scheduler.js';

let _running = false;

export function startScheduler(): void {
  // The pipeline cron is now driven by random_runs.ts.
  configureRandomRuns(async () => { await runPipeline(); });
  startRandomScheduler();
  startFollowerSync();
  startOriginalPostScheduler();
  startAudienceSync();
  startAgentWatcher();

  if (isContextEnabled()) {
    const store = getContextStore();
    if (store) {
      const sources = buildContextSources();
      if (sources.length > 0) {
        startContextIngest(sources, store);
        logger.info('Context ingest started', { sources: sources.map((s) => s.name) });
      } else {
        logger.warn('CONTEXT_ENABLED=true but no sources configured');
      }
    }
  }

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
  stopOriginalPostScheduler();
  stopAudienceSync();
  stopAgentWatcher();
  stopContextIngest();
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
      updatePostScore(post.id, scored.score, scored.breakdown);
      if (scored.score >= minScore) scoredAboveThreshold.push(scored);
    }

    const ranked = rankCandidates(scoredAboveThreshold);
    const maxCandidates = Math.max(1, parseInt(getSetting('max_candidates_per_run', '3'), 10) || 3);
    let topCandidates = ranked.slice(0, maxCandidates);

    // Fallback: if nothing meets the threshold, take the single best on-topic
    // post anyway — but never reach for hindi/unknown posts, which the filter
    // already rejected as unsupported. Replying in English to a Hindi tweet is
    // worse than skipping the run.
    if (topCandidates.length === 0 && newPosts.length > 0) {
      const SUPPORTED_LANGS: DetectedLanguage[] = ['english', 'marathi', 'marathi-roman'];
      const eligible = newPosts.flatMap((post) => {
        const lang = filterResults.get(post.id)?.lang ?? (post.language as DetectedLanguage);
        return SUPPORTED_LANGS.includes(lang) ? [{ post, lang }] : [];
      });
      if (eligible.length > 0) {
        const allScored = eligible.map(({ post, lang }) => scorePost({ ...post, language: lang }));
        const fallback = rankCandidates(allScored)[0];
        if (fallback) {
          const fb = filterResults.get(fallback.id);
          if (fb) {
            updatePostLanguage(fb.post.id, fb.lang);
            updatePostScore(fb.post.id, fallback.score, fallback.breakdown);
          }
          topCandidates = [fallback];
          logEvent('FALLBACK_CANDIDATE_SELECTED', `score=${fallback.score} min=${minScore}`, fallback.id);
        }
      }
    }

    logger.info(`Scored: ${scoredAboveThreshold.length} above threshold, taking top ${topCandidates.length}`);
    logEvent('SCORE_COMPLETE', `${topCandidates.length} candidates selected`);

    // 5. Classify authors → generate replies → notify
    const blocklist = getSetting('blocklist_classifications', 'BOT,SPAM,BRAND_PROMO')
      .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

    let posted = 0;
    for (let i = 0; i < topCandidates.length; i++) {
      const candidate = topCandidates[i];
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
        updateGeneratedReply(post.id, reply);  // sets PENDING_APPROVAL with the reply text

        // Auto-post — no human approval gate.
        updatePostStatus(post.id, 'POSTING');
        logEvent('AUTO_POSTING', `score=${candidate.score}`, post.id);

        try {
          const { replyTweetId } = await postReply(post.tweet_url, reply);
          markPostAsPosted(post.id, replyTweetId);
          recordInteraction(post.id, post.author_handle, reply, {
            tweetId: replyTweetId ?? undefined,
            tweetUrl: replyTweetId ? `https://x.com/i/web/status/${replyTweetId}` : undefined,
          });
          logEvent('POSTED', `reply_id=${replyTweetId ?? 'unknown'}`, post.id);
          posted++;

          // Fire-and-forget: notify the user that we posted, with a Delete button.
          const notif = await sendReplyPostedNotification(
            post,
            reply,
            replyTweetId,
            account?.classification ?? null,
          );
          if (notif.ok) {
            logEvent('NOTIFICATION_SENT', `topic=${notif.topic}`, post.id);
          } else {
            logEvent('NOTIFICATION_FAILED', notif.error ?? 'unknown error', post.id);
          }
        } catch (postErr) {
          logger.error('Auto-post failed', { postId: post.id, err: postErr });
          updatePostStatus(post.id, 'ERROR');
          logEvent('POST_ERROR', String(postErr), post.id);
          continue;
        }

        if (i < topCandidates.length - 1) {
          await delay(randomBetween(8000, 15000));  // rate-limit ourselves between auto-posts
        }
      } catch (err) {
        if (err instanceof EmptyReplyError) {
          logger.warn('Empty reply from Groq — skipping candidate, waiting for next run', { id: candidate.id });
          updatePostStatus(candidate.id, 'SKIPPED');
          logEvent('CANDIDATE_SKIPPED_EMPTY', 'empty reply, skipped', candidate.id);
          continue;
        }
        logger.error('Error processing candidate', { id: candidate.id, err });
        updatePostStatus(candidate.id, 'ERROR');
        logEvent('CANDIDATE_ERROR', String(err), candidate.id);
      }
    }

    logEvent('PIPELINE_COMPLETE', `ingested=${ingested} posted=${posted}`);
    logger.info('Pipeline complete', { ingested, posted });
    return { ingested, candidates: posted };
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
