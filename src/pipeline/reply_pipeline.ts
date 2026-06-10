import { ingestTimeline } from '../browser/ingestion.js';
import { postReply } from '../browser/posting.js';
import { sendApprovalNotification, sendReplyPostedNotification } from '../notifications/ntfy.js';
import { getPost, logEvent, markPostAsPosted, Post, updateGeneratedReply, updatePostLanguage, updatePostScore, updatePostStatus, upsertPost } from '../storage/queries.js';
import { upsertAccountSeen } from '../storage/accounts.js';
import { listRecentReplyTexts, recordInteraction } from '../storage/interactions.js';
import { getBooleanSetting, getFloatSetting, getIntSetting, getListSetting } from '../storage/settings.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';
import { classifyAccount } from './classifier.js';
import { EmptyReplyError } from './errors.js';
import { DetectedLanguage, filterPost } from './filter.js';
import { generateReply } from './generator.js';
import { rankCandidates, scorePost, ScoredPost } from './scorer.js';
import { generateDistinct } from './dedup.js';

interface FilteredPost {
  post: Post;
  lang: DetectedLanguage;
}

interface FilterRecord extends FilteredPost {
  passed: boolean;
}

let _running = false;

export async function runReplyPipeline(): Promise<{ ingested: number; candidates: number }> {
  if (_running) {
    logger.warn('Pipeline already running - skipping overlapping run');
    return { ingested: 0, candidates: 0 };
  }

  if (!getBooleanSetting('system_running', true)) {
    logger.info('System paused - skipping pipeline run');
    return { ingested: 0, candidates: 0 };
  }

  _running = true;
  logEvent('PIPELINE_START');

  try {
    const rawTweets = await ingestTimeline(60);
    logEvent('INGESTION_COMPLETE', `${rawTweets.length} raw tweets`);

    const { ingested, newPosts } = ingestNewPosts(rawTweets);
    logger.info(`Ingested ${ingested} new posts (${rawTweets.length - ingested} duplicates skipped)`);

    const { filtered, filterResults } = filterNewPosts(newPosts);
    logger.info(`Filter: ${filtered.length}/${ingested} posts passed`);
    logEvent('FILTER_COMPLETE', `${filtered.length} passed`);

    const topCandidates = selectCandidates(filtered, filterResults, newPosts);
    logger.info(`Scored candidates selected: ${topCandidates.length}`);
    logEvent('SCORE_COMPLETE', `${topCandidates.length} candidates selected`);

    const blocklist = getListSetting('blocklist_classifications', ['BOT', 'SPAM', 'BRAND_PROMO'])
      .map((value) => value.toUpperCase());

    let posted = 0;
    let pendingApproval = 0;
    for (let i = 0; i < topCandidates.length; i++) {
      const outcome = await processCandidate(topCandidates[i], blocklist);
      if (outcome === 'posted') posted++;
      if (outcome === 'pending_approval') pendingApproval++;
      if (outcome === 'posted' && i < topCandidates.length - 1) {
        await delay(randomBetween(8000, 15000));
      }
    }

    logEvent('PIPELINE_COMPLETE', `ingested=${ingested} posted=${posted} pending=${pendingApproval}`);
    logger.info('Pipeline complete', { ingested, posted, pendingApproval });
    return { ingested, candidates: posted + pendingApproval };
  } catch (err) {
    logger.error('Pipeline failed', { err });
    logEvent('PIPELINE_ERROR', String(err));
    throw err;
  } finally {
    _running = false;
  }
}

export function isReplyPipelineRunning(): boolean {
  return _running;
}

function ingestNewPosts(rawTweets: Parameters<typeof upsertPost>[0][]): { ingested: number; newPosts: Post[] } {
  let ingested = 0;
  const newPosts: Post[] = [];

  for (const tweet of rawTweets) {
    const post = upsertPost(tweet);
    if (!post) continue;
    ingested++;
    newPosts.push(post);
    upsertAccountSeen(tweet.author_handle, tweet.author_name);
  }

  return { ingested, newPosts };
}

function filterNewPosts(newPosts: Post[]): {
  filtered: FilteredPost[];
  filterResults: Map<string, FilterRecord>;
} {
  const extraKeywords = getListSetting('topic_keywords');
  const filtered: FilteredPost[] = [];
  const filterResults = new Map<string, FilterRecord>();

  for (const post of newPosts) {
    const result = filterPost(post.text, extraKeywords);
    filterResults.set(post.id, { post, lang: result.language, passed: result.pass });
    if (result.pass) {
      updatePostLanguage(post.id, result.language);
      filtered.push({ post, lang: result.language });
    } else {
      updatePostStatus(post.id, 'SKIPPED');
    }
  }

  return { filtered, filterResults };
}

function selectCandidates(
  filtered: FilteredPost[],
  filterResults: Map<string, FilterRecord>,
  newPosts: Post[],
): ScoredPost[] {
  const minScore = getFloatSetting('min_score', 40, 0, 100);
  const scoredAboveThreshold: ScoredPost[] = [];

  for (const { post, lang } of filtered) {
    const scored = scorePost({ ...post, language: lang });
    updatePostScore(post.id, scored.score, scored.breakdown);
    if (scored.score >= minScore) scoredAboveThreshold.push(scored);
  }

  const maxCandidates = getIntSetting('max_candidates_per_run', 3, 1, 10);
  const ranked = rankCandidates(scoredAboveThreshold);
  const topCandidates = ranked.slice(0, maxCandidates);
  if (topCandidates.length > 0 || newPosts.length === 0) return topCandidates;

  const fallback = selectFallbackCandidate(newPosts, filterResults, minScore);
  return fallback ? [fallback] : [];
}

function selectFallbackCandidate(
  newPosts: Post[],
  filterResults: Map<string, FilterRecord>,
  minScore: number,
): ScoredPost | null {
  const supportedLangs: DetectedLanguage[] = ['english', 'marathi', 'marathi-roman'];
  const eligible = newPosts.flatMap((post) => {
    const lang = filterResults.get(post.id)?.lang ?? (post.language as DetectedLanguage);
    return supportedLangs.includes(lang) ? [{ post, lang }] : [];
  });
  if (eligible.length === 0) return null;

  const fallback = rankCandidates(eligible.map(({ post, lang }) => scorePost({ ...post, language: lang })))[0];
  if (!fallback) return null;

  const record = filterResults.get(fallback.id);
  if (record) {
    updatePostLanguage(record.post.id, record.lang);
    updatePostScore(record.post.id, fallback.score, fallback.breakdown);
  }
  logEvent('FALLBACK_CANDIDATE_SELECTED', `score=${fallback.score} min=${minScore}`, fallback.id);
  return fallback;
}

type CandidateOutcome = 'posted' | 'pending_approval' | 'skipped' | 'error';

async function processCandidate(candidate: ScoredPost, blocklist: string[]): Promise<CandidateOutcome> {
  try {
    const post = getPost(candidate.id);
    if (!post) return 'skipped';

    let account = null;
    try {
      account = await classifyAccount(post.author_handle, post.author_name, {
        fetchProfileIfMissing: true,
      });
      logEvent(
        'AUTHOR_CLASSIFIED',
        `${post.author_handle} -> ${account.classification ?? 'UNKNOWN'} (${(account.classification_confidence * 100).toFixed(0)}%)`,
        post.id,
      );
    } catch (err) {
      logger.warn('Classification failed; continuing with UNKNOWN', { err: String(err) });
    }

    if (account?.classification && blocklist.includes(account.classification)) {
      updatePostStatus(post.id, 'SKIPPED');
      logEvent('SKIPPED_BY_CLASSIFICATION', `${account.classification} on blocklist`, post.id);
      return 'skipped';
    }

    updatePostStatus(post.id, 'GENERATING');
    const recentReplies = listRecentReplyTexts(25);
    const distinct = await generateDistinct({
      existingTexts: recentReplies,
      generate: (attempt) => generateReply(
        post,
        account,
        attempt > 1 ? { avoidTexts: recentReplies } : {},
      ),
      getText: (value) => value,
      onDuplicate: (_value, attempt) => {
        logEvent('DUPLICATE_REPLY_REJECTED', `attempt=${attempt}`, post.id);
        logger.warn('Generated reply matched recent reply history', { postId: post.id, attempt });
      },
    });
    if (!distinct.value) {
      updatePostStatus(post.id, 'SKIPPED');
      logEvent('CANDIDATE_SKIPPED_DUPLICATE', 'two duplicate drafts', post.id);
      return 'skipped';
    }
    const reply = distinct.value;
    updateGeneratedReply(post.id, reply);

    // Human-in-the-loop mode: stop at PENDING_APPROVAL and ask via ntfy.
    // The approve endpoint posts the reply; the expiry sweep handles ignores.
    if (getBooleanSetting('require_approval', true)) {
      const pending = getPost(post.id)!;
      const notification = await sendApprovalNotification(pending);
      logEvent(
        notification.ok ? 'AWAITING_APPROVAL' : 'NOTIFICATION_FAILED',
        notification.ok ? `score=${candidate.score}` : (notification.error ?? 'unknown error'),
        post.id,
      );
      return 'pending_approval';
    }

    updatePostStatus(post.id, 'POSTING');
    logEvent('AUTO_POSTING', `score=${candidate.score}`, post.id);

    const { replyTweetId } = await postReply(post.tweet_url, reply);
    markPostAsPosted(post.id, replyTweetId);
    recordInteraction(post.id, post.author_handle, reply, {
      tweetId: replyTweetId ?? undefined,
      tweetUrl: replyTweetId ? `https://x.com/i/web/status/${replyTweetId}` : undefined,
    });
    logEvent('POSTED', `reply_id=${replyTweetId ?? 'unknown'}`, post.id);

    const notification = await sendReplyPostedNotification(
      post,
      reply,
      replyTweetId,
      account?.classification ?? null,
    );
    if (notification.ok) {
      logEvent('NOTIFICATION_SENT', `topic=${notification.topic}`, post.id);
    } else {
      logEvent('NOTIFICATION_FAILED', notification.error ?? 'unknown error', post.id);
    }
    return 'posted';
  } catch (err) {
    if (err instanceof EmptyReplyError) {
      logger.warn('Empty reply from Groq - skipping candidate, waiting for next run', { id: candidate.id });
      updatePostStatus(candidate.id, 'SKIPPED');
      logEvent('CANDIDATE_SKIPPED_EMPTY', 'empty reply, skipped', candidate.id);
      return 'skipped';
    }

    logger.error('Error processing candidate', { id: candidate.id, err });
    updatePostStatus(candidate.id, 'ERROR');
    logEvent('CANDIDATE_ERROR', String(err), candidate.id);
    return 'error';
  }
}
