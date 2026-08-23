import { ingestTimeline } from '../browser/ingestion.js';
import { sendApprovalNotification } from '../notifications/ntfy.js';
import { getHandlesRepliedToToday, getRepliesPostedTodayCount, getTopicCountsToday, getPost, logEvent, Post, PostSource, Stance, updateGeneratedReply, updatePostLanguage, updatePostScore, updatePostStatus, upsertPost } from '../storage/queries.js';
import { detectTopics } from '../context/topics.js';
import { upsertAccountSeen } from '../storage/accounts.js';
import { listRecentReplyTexts } from '../storage/interactions.js';
import { getBooleanSetting, getBooleanSettingFromSchema, getFloatSetting, getIntSetting, getIntSettingFromSchema, getListSetting } from '../storage/settings.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';
import { classifyAccount } from './classifier.js';
import { EmptyReplyError, GravitySkipError } from './errors.js';
import { DetectedLanguage, filterPost } from './filter.js';
import { generateReplyWithMeta } from './generator.js';
import { rankCandidates, scorePostsWithSignals, ScoredPost } from './scorer.js';
import { getVelocityConfig } from './velocity.js';
import { generateDistinct } from './dedup.js';
import { publishReply } from './reply_publisher.js';
import { runReplyRetryQueue } from './reply_retry.js';
import { sourceTrendCandidates, type TrendCandidate } from './trend_source.js';
import { secondsUntilNextReplyAllowed } from './rate_limit.js';
import { recordTrendReply } from '../trends/x_trends.js';
import { classifyTrendSafety } from '../trends/trend_filter.js';
import { updatePostStance } from '../storage/queries.js';
import { instrumentPipelineRun, recordPipelineSkipped } from '../telemetry/instrument.js';
import { notePipelineDelivery } from './stalled_delivery.js';
import { getPoolCandidates, markPostPostingError, recordObservation, setPostLastError, updatePostTournamentMeta } from '../storage/posts.js';

interface FilteredPost {
  post: Post;
  lang: DetectedLanguage;
}

interface FilterRecord extends FilteredPost {
  passed: boolean;
}

let _running = false;

export interface RunReplyPipelineOptions {
  /**
   * Where this run should look for candidates. Defaults to TIMELINE so the
   * manual "Run Now" button and any existing caller behave exactly as before.
   */
  source?: PostSource;
}

export interface PipelineRunResult {
  ingested: number;
  candidates: number;
  posted: number;
  pendingApproval: number;
}

function emptyRun(): PipelineRunResult {
  return { ingested: 0, candidates: 0, posted: 0, pendingApproval: 0 };
}

export async function runReplyPipeline(
  opts: RunReplyPipelineOptions = {},
): Promise<PipelineRunResult> {
  const source = opts.source ?? 'TIMELINE';

  if (_running) {
    logger.warn('Pipeline already running - skipping overlapping run');
    recordPipelineSkipped(source, 'overlap');
    return emptyRun();
  }

  if (!getBooleanSetting('system_running', true)) {
    logger.info('System paused - skipping pipeline run');
    recordPipelineSkipped(source, 'paused');
    return emptyRun();
  }

  const maxRepliesPerDay = getIntSetting('max_replies_per_day', 8, 1, 50);
  const repliesSoFarToday = getRepliesPostedTodayCount();
  const remainingBudget = Math.max(0, maxRepliesPerDay - repliesSoFarToday);
  if (remainingBudget === 0) {
    logger.info('Daily reply cap reached - skipping run', { repliesSoFarToday, maxRepliesPerDay });
    logEvent('DAILY_REPLY_CAP_REACHED', `posted=${repliesSoFarToday} cap=${maxRepliesPerDay}`);
    recordPipelineSkipped(source, 'daily_cap');
    return emptyRun();
  }

  return instrumentPipelineRun(source, async () => {
    _running = true;
    logEvent('PIPELINE_START', `source=${source}`);

    try {
    const retries = await runReplyRetryQueue();
    if (retries.due > 0) {
      logEvent('POST_RETRY_QUEUE_COMPLETE', `posted=${retries.posted} failed=${retries.failed}`);
    }

    const blocklist = getListSetting('blocklist_classifications', ['BOT', 'SPAM', 'BRAND_PROMO'])
      .map((value) => value.toUpperCase());

    if (source !== 'TIMELINE' && getBooleanSetting('trend_replies_enabled', true)) {
      const trendCandidates = await sourceTrendCandidates(source);
      if (trendCandidates.candidates.length > 0) {
        const result = await processTrendCandidates(trendCandidates.candidates, blocklist, remainingBudget);
        logEvent('PIPELINE_COMPLETE', `source=${source} trend="${trendCandidates.trendName}" posted=${result.posted} pending=${result.pendingApproval}`);
        logger.info('Trend pipeline complete', { source, trend: trendCandidates.trendName, ...result });
        const summary = {
          ingested: trendCandidates.candidates.length,
          candidates: result.posted + result.pendingApproval,
          posted: result.posted,
          pendingApproval: result.pendingApproval,
        };
        await notePipelineDelivery(summary);
        return summary;
      }
      logEvent('TREND_SOURCING_EMPTY', `source=${source} — falling back to timeline`);
      logger.info('Trend sourcing produced nothing; falling back to home timeline', { source });
    }

    const rawTweets = await ingestTimeline(60);
    logEvent('INGESTION_COMPLETE', `${rawTweets.length} raw tweets`);

    const { ingested, newPosts } = ingestNewPosts(rawTweets);
    logger.info(`Ingested ${ingested} new posts (${rawTweets.length - ingested} duplicates skipped)`);

    const pool = carryOverPool(newPosts);
    const candidates = [...newPosts, ...pool];

    const { filtered, filterResults } = filterNewPosts(candidates);
    logger.info(`Filter: ${filtered.length}/${candidates.length} posts passed`);
    logEvent('FILTER_COMPLETE', `${filtered.length} passed`);

    const scoredCandidates = await selectCandidates(filtered, filterResults, candidates);
    const topCandidates = scoredCandidates.slice(0, remainingBudget);
    logger.info(`Scored candidates selected: ${topCandidates.length}`, { remainingBudget });
    logEvent('SCORE_COMPLETE', `${topCandidates.length} candidates selected (budget=${remainingBudget})`);

    let posted = 0;
    let pendingApproval = 0;
    for (let i = 0; i < topCandidates.length && posted < remainingBudget; i++) {
      const outcome = await processCandidate(topCandidates[i], blocklist);
      if (outcome === 'posted') posted++;
      if (outcome === 'pending_approval') pendingApproval++;
      if (outcome === 'posted' && i < topCandidates.length - 1) {
        await delay(randomBetween(8000, 15000));
      }
    }

    logEvent('PIPELINE_COMPLETE', `ingested=${ingested} posted=${posted} pending=${pendingApproval}`);
    logger.info('Pipeline complete', { ingested, posted, pendingApproval });
    const summary = {
      ingested,
      candidates: posted + pendingApproval,
      posted,
      pendingApproval,
    };
    await notePipelineDelivery(summary);
    return summary;
    } catch (err) {
      logger.error('Pipeline failed', { err });
      logEvent('PIPELINE_ERROR', String(err));
      throw err;
    } finally {
      _running = false;
    }
  });
}

/**
 * Posts trend candidates with heavier pacing than the timeline path.
 *
 * Under a live trending hashtag, five replies 8-15s apart is exactly the burst
 * pattern that draws rate-limiting — on the home timeline the same cadence is
 * invisible. So trend runs take fewer candidates and space them further apart.
 * The daily total is unchanged; it just arrives less suspiciously.
 */
async function processTrendCandidates(
  candidates: TrendCandidate[],
  blocklist: string[],
  remainingBudget: number,
): Promise<{ posted: number; pendingApproval: number }> {
  const maxCandidates = Math.min(getIntSetting('max_candidates_per_run', 5, 1, 20), 3, remainingBudget);
  const minIntervalSec = getIntSetting('trend_min_reply_interval_sec', 90, 0, 600);
  const selected = candidates.slice(0, maxCandidates);

  let posted = 0;
  let pendingApproval = 0;

  for (let i = 0; i < selected.length && posted < remainingBudget; i++) {
    const candidate = selected[i];
    const outcome = await processCandidate(candidate.scored, blocklist, candidate.post.stance ?? null);

    if (outcome === 'posted') {
      posted++;
      recordTrendReply(candidate.trendKey);
    }
    if (outcome === 'pending_approval') pendingApproval++;

    if (outcome === 'posted' && i < selected.length - 1) {
      const waitSec = secondsUntilNextReplyAllowed(minIntervalSec);
      await delay(Math.max(randomBetween(8000, 15000), waitSec * 1000));
    }
  }

  return { posted, pendingApproval };
}

export function isReplyPipelineRunning(): boolean {
  return _running;
}

function ingestNewPosts(rawTweets: Parameters<typeof upsertPost>[0][]): { ingested: number; newPosts: Post[] } {
  let ingested = 0;
  const newPosts: Post[] = [];

  for (const tweet of rawTweets) {
    const post = upsertPost(tweet);
    if (!post) {
      // Already held. The counts on this sighting are what let us measure a
      // real like-rate rather than assuming one; status is left untouched.
      recordObservation(tweet.tweet_id, tweet.likes, tweet.replies);
      continue;
    }
    ingested++;
    newPosts.push(post);
    upsertAccountSeen(tweet.author_handle, tweet.author_name);
  }

  return { ingested, newPosts };
}

/**
 * Candidates carried over from earlier runs, minus anything ingested just now.
 *
 * The pipeline used to consider only tweets inserted during the current run and
 * silently drop the rest — 811 rows were sitting in INGESTED having never been
 * reconsidered. A tweet that looked flat when first seen and caught fire ten
 * minutes later could therefore never be picked, which is exactly the shot
 * velocity targeting exists to take. Re-filtering also prunes the pool, since
 * anything failing the filter is marked SKIPPED on the way through.
 */
function carryOverPool(newPosts: Post[]): Post[] {
  if (!getBooleanSettingFromSchema('velocity_pool_enabled')) return [];
  const maxAgeMin = getIntSettingFromSchema('velocity_pool_max_age_min');
  const seen = new Set(newPosts.map((p) => p.id));
  const pool = getPoolCandidates(maxAgeMin).filter((p) => !seen.has(p.id));
  if (pool.length > 0) {
    logger.info('Carried over pooled candidates', { pooled: pool.length, maxAgeMin });
  }
  return pool;
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

async function selectCandidates(
  filtered: FilteredPost[],
  filterResults: Map<string, FilterRecord>,
  newPosts: Post[],
): Promise<ScoredPost[]> {
  const minScore = getFloatSetting('min_score', 40, 0, 100);
  // topic_daily_cap is a PERCENTAGE (default 10 = 10%) of planned daily volume
  const topicCapPct = getIntSetting('topic_daily_cap', 10, 1, 100);
  const plannedReplies = getIntSetting('random_runs_per_day', 20, 1, 30) * getIntSetting('max_candidates_per_run', 5, 1, 20);
  const plannedOriginals = getIntSetting('original_posts_per_day', 2, 1, 15);
  const topicDailyCap = Math.max(3, Math.ceil((plannedReplies + plannedOriginals) * topicCapPct / 100));
  // One reply per account per day
  const alreadyRepliedToday = getHandlesRepliedToToday();
  // Topic diversity cap — load once per run
  const topicCountsToday = getTopicCountsToday();

  const supportedLangs: DetectedLanguage[] = ['english', 'marathi', 'marathi-roman'];
  const scorablePosts = newPosts.flatMap((post) => {
    const lang = filterResults.get(post.id)?.lang ?? (post.language as DetectedLanguage);
    return supportedLangs.includes(lang) ? [{ ...post, language: lang }] : [];
  });
  const scoredById = new Map(
    (await scorePostsWithSignals(scorablePosts)).map((scored) => [scored.id, scored]),
  );
  const scoredAboveThreshold: ScoredPost[] = [];

  for (const { post, lang } of filtered) {
    // Skip if we already replied to this account today
    if (alreadyRepliedToday.has(post.author_handle)) {
      updatePostStatus(post.id, 'SKIPPED');
      logEvent('SKIPPED_ALREADY_REPLIED_TODAY', `@${post.author_handle} already received a reply today`, post.id);
      continue;
    }
    // Skip if any detected topic for this post has hit the daily cap
    const postTopics = detectTopics(post.text);
    const cappedTopic = postTopics.find((t) => (topicCountsToday.get(t) ?? 0) >= topicDailyCap);
    if (cappedTopic) {
      updatePostStatus(post.id, 'SKIPPED');
      logEvent('SKIPPED_TOPIC_CAP', `topic="${cappedTopic}" at ${topicCountsToday.get(cappedTopic)}/${topicDailyCap} today`, post.id);
      continue;
    }
    const scored = scoredById.get(post.id);
    if (!scored) continue;
    updatePostScore(post.id, scored.score, scored.breakdown);
    if (scored.score >= minScore) scoredAboveThreshold.push(scored);
  }

  const maxCandidates = getIntSetting('max_candidates_per_run', 5, 1, 20);
  const ranked = rankCandidates(scoredAboveThreshold);
  const topCandidates = ranked.slice(0, maxCandidates);

  // Velocity targeting deliberately posts fewer replies on quiet days rather
  // than spending the budget on tweets nobody is reading — so make the trade
  // visible instead of letting the count quietly sag.
  logVelocitySelection(scoredById, topCandidates);

  if (topCandidates.length > 0 || newPosts.length === 0) return topCandidates;

  const fallback = selectFallbackCandidate(newPosts, filterResults, scoredById, minScore, alreadyRepliedToday, topicCountsToday, topicDailyCap); // cap already computed above
  return fallback ? [fallback] : [];
}

/** Reports what the reach multiplier did to this run's candidate pool. */
function logVelocitySelection(
  scoredById: Map<string, ScoredPost>,
  selected: ScoredPost[],
): void {
  const all = [...scoredById.values()];
  if (all.length === 0) return;

  const cfg = getVelocityConfig();
  const dead = all.filter((s) => s.breakdown.reachFactor < 0.5).length;
  const picked = selected.map((s) => s.breakdown.velocityLpm);
  const medianLpm = picked.length
    ? [...picked].sort((a, b) => a - b)[Math.floor(picked.length / 2)]
    : 0;

  logger.info('Velocity targeting', {
    scored: all.length,
    selected: selected.length,
    lowReach: dead,
    medianLpmSelected: medianLpm,
    strikeWindowMin: cfg.strikeWindowMin,
    minLpm: cfg.minLikesPerMin,
  });
  logEvent(
    'VELOCITY_SELECTION',
    `scored=${all.length} selected=${selected.length} lowReach=${dead} medianLpm=${medianLpm}`,
  );
}

function selectFallbackCandidate(
  newPosts: Post[],
  filterResults: Map<string, FilterRecord>,
  scoredById: Map<string, ScoredPost>,
  minScore: number,
  alreadyRepliedToday: Set<string> = new Set(),
  topicCountsToday: Map<string, number> = new Map(),
  topicDailyCap: number = 10,
): ScoredPost | null {
  const supportedLangs: DetectedLanguage[] = ['english', 'marathi', 'marathi-roman'];
  const eligible = newPosts.flatMap((post) => {
    if (alreadyRepliedToday.has(post.author_handle)) return [];
    const postTopics = detectTopics(post.text);
    const cappedTopic = postTopics.find((t) => (topicCountsToday.get(t) ?? 0) >= topicDailyCap);
    if (cappedTopic) return [];
    const lang = filterResults.get(post.id)?.lang ?? (post.language as DetectedLanguage);
    return supportedLangs.includes(lang) ? [{ post, lang }] : [];
  });
  if (eligible.length === 0) return null;

  const fallback = rankCandidates(
    eligible.flatMap(({ post }) => {
      const scored = scoredById.get(post.id);
      return scored ? [scored] : [];
    }),
  )[0];
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

async function processCandidate(
  candidate: ScoredPost,
  blocklist: string[],
  stance: Stance | null = null,
): Promise<CandidateOutcome> {
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

    // Last line of defence before a contrarian take reaches the model. The
    // stance was already gated on safety when it was assigned; re-asserting it
    // here means a future refactor can't quietly route around that check.
    let safeStance: Stance | null = stance ?? post.stance ?? null;
    if (safeStance === 'CONTRARIAN') {
      const postSafety = classifyTrendSafety(post.text);
      if (postSafety.class !== 'SAFE_FOR_CONTRARIAN') {
        logEvent('CONTRARIAN_BLOCKED', `post text classified ${postSafety.class} (${postSafety.reason})`, post.id);
        logger.warn('Contrarian stance blocked by post-text safety check', {
          postId: post.id, class: postSafety.class, reason: postSafety.reason,
        });
        updatePostStance(post.id, 'ALIGNED');
        safeStance = 'ALIGNED';
      }
    }

    const recentReplies = listRecentReplyTexts(25);
    const distinct = await generateDistinct({
      existingTexts: recentReplies,
      generate: (attempt) => generateReplyWithMeta(
        post,
        account,
        attempt > 1 ? { avoidTexts: recentReplies, stance: safeStance } : { stance: safeStance },
      ),
      getText: (value) => value.text,
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
    const generated = distinct.value;
    const reply = generated.text;
    updateGeneratedReply(post.id, reply);
    if (generated.tournament) {
      try {
        updatePostTournamentMeta(post.id, {
          strategy: generated.tournament.strategy,
          angle: generated.tournament.angle,
          criticScore: generated.tournament.criticScore,
          criticReasons: generated.tournament.criticReasons,
        });
      } catch {
        // Synthetic posts in tests may omit tournament columns until migration.
      }
    }

    // Human-in-the-loop mode: stop at PENDING_APPROVAL and ask via ntfy.
    // Default is autonomous (require_approval=false). Enable in dashboard Settings to require approval.
    if (getBooleanSetting('require_approval', false)) {
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

    const publishOutcome = await publishReply(post, reply, account?.classification ?? null, {
      contentStructure: generated.contentStructure,
    });
    return publishOutcome === 'posted' ? 'posted' : 'error';
  } catch (err) {
    if (err instanceof EmptyReplyError) {
      logger.warn('Empty reply from Groq - skipping candidate, waiting for next run', { id: candidate.id });
      updatePostStatus(candidate.id, 'SKIPPED');
      setPostLastError(candidate.id, 'empty reply from provider');
      logEvent('CANDIDATE_SKIPPED_EMPTY', 'empty reply, skipped', candidate.id);
      return 'skipped';
    }
    if (err instanceof GravitySkipError) {
      logger.warn('Conversation gravity too low - skipping candidate', { id: candidate.id, err: err.message });
      updatePostStatus(candidate.id, 'SKIPPED');
      setPostLastError(candidate.id, err.message);
      logEvent('CANDIDATE_SKIPPED_GRAVITY', err.message, candidate.id);
      return 'skipped';
    }

    logger.error('Error processing candidate', { id: candidate.id, err });
    markPostPostingError(candidate.id, String(err));
    logEvent('CANDIDATE_ERROR', String(err), candidate.id);
    return 'error';
  }
}
