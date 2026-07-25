/**
 * Sources reply candidates from a trending topic instead of the home timeline.
 *
 * Flow: pick an eligible trend for the location -> run an X search for it ->
 * ingest, filter and score the results with the trend profile -> assign a
 * stance. Everything downstream (classification, blocklist, generation,
 * publishing) is the shared pipeline, unchanged.
 */
import { searchTweets } from '../browser/ingestion.js';
import { getDb } from '../storage/db.js';
import {
  getHandlesRepliedToToday, getTopicCountsToday, logEvent, updatePostScore,
  updatePostStance, upsertPost, type Post, type PostSource,
} from '../storage/queries.js';
import { upsertAccountSeen } from '../storage/accounts.js';
import { getIntSetting } from '../storage/settings.js';
import { detectTopics } from '../context/topics.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';
import { keywordMatches } from './keywords.js';
import { filterTrendPost } from './filter.js';
import { rankCandidates, scoreTrendPosts, type ScoredPost } from './scorer.js';
import { decideStance } from './stance.js';
import {
  recordEnglishYield, refreshTrendsIfStale, WOEIDS, type TrendRow,
} from '../trends/x_trends.js';
import { classifyTrendSafety, combineSafety, type TrendSafetyClass } from '../trends/trend_filter.js';

/** Max trends to try in one run before giving up and letting the caller fall back. */
const MAX_TRENDS_PER_RUN = 2;
const SEARCH_MAX_RESULTS = 25;
/** Below this many usable candidates, also sweep the Latest tab. */
const LATEST_TOP_UP_THRESHOLD = 5;
/** If more than this share of a batch is off-topic, the search DOM likely changed. */
const OFF_TOPIC_ALARM_RATIO = 0.7;

export interface TrendCandidate {
  scored: ScoredPost;
  post: Post;
  trendKey: string;
  safetyClass: TrendSafetyClass;
}

export interface TrendSourcingResult {
  candidates: TrendCandidate[];
  trendName: string | null;
}

/**
 * Ranks a trend's momentum.
 *
 * Rewards trends we've barely seen (they're new), trends climbing the ranks,
 * and trends that have been near the top — all cheap proxies for "this is
 * still accelerating" rather than "this peaked six hours ago".
 */
export function trendHeat(trend: TrendRow): number {
  let heat = 0;
  if (trend.poll_count <= 2) heat += 8;
  if (trend.prev_rank !== null && trend.prev_rank > trend.last_rank) heat += 5;
  if (trend.best_rank <= 10) heat += 4;
  return Math.min(15, heat);
}

/** Trends eligible to be replied to right now, best first. */
export function selectEligibleTrends(woeid: number): TrendRow[] {
  const now = Math.floor(Date.now() / 1000);
  const maxPerDay = getIntSetting('trend_max_replies_per_day', 2, 1, 10);

  const rows = getDb().prepare(`
    SELECT * FROM trends
    WHERE woeid = ?
      AND script = 'latin'
      AND safety_class != 'SKIP'
      AND replies_sent < ?
      AND (cooldown_until IS NULL OR cooldown_until <= ?)
      AND last_seen_at >= ?
    ORDER BY last_rank ASC
  `).all(woeid, maxPerDay, now, now - 6 * 3600) as TrendRow[];

  // Sort by heat, with a small random tiebreak so equal-heat trends rotate
  // instead of the same one winning every run.
  return rows
    .map((t) => ({ t, h: trendHeat(t) + Math.random() }))
    .sort((a, b) => b.h - a.h)
    .map(({ t }) => t);
}

/**
 * Collects reply candidates for one location.
 *
 * Returns an empty list rather than throwing when anything fails — the caller
 * falls through to the home timeline, so a trends outage costs zero replies.
 */
export async function sourceTrendCandidates(source: PostSource): Promise<TrendSourcingResult> {
  if (source === 'TIMELINE') return { candidates: [], trendName: null };
  const woeid = WOEIDS[source];

  try {
    await refreshTrendsIfStale();
  } catch (err) {
    logger.warn('Trend refresh failed during sourcing', { err: String(err).slice(0, 200) });
  }

  const eligible = selectEligibleTrends(woeid);
  if (eligible.length === 0) {
    logEvent('TREND_NONE_ELIGIBLE', `source=${source}`);
    return { candidates: [], trendName: null };
  }

  for (let i = 0; i < Math.min(MAX_TRENDS_PER_RUN, eligible.length); i++) {
    const trend = eligible[i];
    if (i > 0) await delay(randomBetween(4000, 9000));

    const candidates = await candidatesForTrend(trend, source);
    recordEnglishYield(trend.key, candidates.length);

    if (candidates.length > 0) {
      logEvent('TREND_CANDIDATES_FOUND', `trend="${trend.name}" source=${source} n=${candidates.length}`);
      return { candidates, trendName: trend.name };
    }
    logger.info('Trend yielded no usable candidates', { trend: trend.name, source });
  }

  return { candidates: [], trendName: null };
}

async function candidatesForTrend(trend: TrendRow, source: PostSource): Promise<TrendCandidate[]> {
  let raw = await searchTweets(trend.query, { mode: 'Top', max: SEARCH_MAX_RESULTS });

  // Top ranks by engagement, which is what we want — but if it's thin (a very
  // new trend), Latest fills the gap.
  if (raw.length < LATEST_TOP_UP_THRESHOLD) {
    await delay(randomBetween(3000, 6000));
    const latest = await searchTweets(trend.query, { mode: 'Latest', max: SEARCH_MAX_RESULTS });
    const seen = new Set(raw.map((t) => t.tweet_id));
    raw = [...raw, ...latest.filter((t) => !seen.has(t.tweet_id))];
  }

  if (raw.length === 0) return [];

  // Ingest. Duplicates return null via ON CONFLICT, so tweets we've already
  // seen (from the timeline or an earlier trend) are skipped for free.
  const newPosts: Post[] = [];
  for (const tweet of raw) {
    const post = upsertPost(tweet, { source, trendKey: trend.key });
    if (!post) continue;
    newPosts.push(post);
    upsertAccountSeen(tweet.author_handle, tweet.author_name);
  }
  if (newPosts.length === 0) return [];

  const alreadyRepliedToday = getHandlesRepliedToToday();
  const topicCountsToday = getTopicCountsToday();
  const topicDailyCap = computeTopicDailyCap();
  const trendToken = trend.name.replace(/^#/, '');

  let offTopic = 0;
  const eligible: Array<{ post: Post; safetyClass: TrendSafetyClass }> = [];

  for (const post of newPosts) {
    if (alreadyRepliedToday.has(post.author_handle)) continue;

    const filtered = filterTrendPost(post.text);
    if (!filtered.pass) continue;

    // Sanity net: search results should mention the thing we searched for.
    // A whole batch failing this means the search page stopped returning what
    // we think it returns.
    if (!keywordMatches(post.text, trendToken)) {
      offTopic++;
      continue;
    }

    const postTopics = detectTopics(post.text);
    if (postTopics.some((t) => (topicCountsToday.get(t) ?? 0) >= topicDailyCap)) continue;

    // Re-run safety on the tweet's own text: a harmless trend can still surface
    // a death announcement, and that must never get a contrarian reply.
    const postSafety = classifyTrendSafety(post.text);
    if (postSafety.class === 'SKIP') {
      logEvent('TREND_POST_SKIPPED_UNSAFE', `reason=${postSafety.reason}`, post.id);
      continue;
    }

    eligible.push({
      post,
      safetyClass: combineSafety(trend.safety_class, postSafety.class),
    });
  }

  if (newPosts.length > 0 && offTopic / newPosts.length > OFF_TOPIC_ALARM_RATIO) {
    logEvent('TREND_SEARCH_OFF_TOPIC', `trend="${trend.name}" ${offTopic}/${newPosts.length} results did not mention it`);
    logger.warn('Most trend search results were off-topic — X search DOM may have changed', {
      trend: trend.name, offTopic, total: newPosts.length,
    });
  }

  if (eligible.length === 0) return [];

  const heat = trendHeat(trend);
  const scored = scoreTrendPosts(eligible.map((e) => e.post), heat);
  const scoredById = new Map(scored.map((s) => [s.id, s]));
  const safetyById = new Map(eligible.map((e) => [e.post.id, e.safetyClass]));
  const postById = new Map(eligible.map((e) => [e.post.id, e.post]));

  for (const s of scored) updatePostScore(s.id, s.score, s.breakdown);

  const contrarianPct = getIntSetting('contrarian_reply_pct', 33, 0, 100);

  return rankCandidates(scored).flatMap((s) => {
    const post = postById.get(s.id);
    const safetyClass = safetyById.get(s.id);
    if (!post || !safetyClass) return [];

    const { stance, reason } = decideStance({ safetyClass, targetPct: contrarianPct });
    updatePostStance(post.id, stance);
    logEvent('TREND_STANCE_ASSIGNED', `stance=${stance} (${reason}) safety=${safetyClass}`, post.id);

    return [{ scored: scoredById.get(s.id)!, post, trendKey: trend.key, safetyClass }];
  });
}

/** Same per-topic cap the timeline path uses — trend replies count toward it too. */
function computeTopicDailyCap(): number {
  const topicCapPct = getIntSetting('topic_daily_cap', 10, 1, 100);
  const plannedReplies = getIntSetting('random_runs_per_day', 20, 1, 30)
    * getIntSetting('max_candidates_per_run', 5, 1, 20);
  const plannedOriginals = getIntSetting('original_posts_per_day', 10, 1, 15);
  return Math.max(3, Math.ceil((plannedReplies + plannedOriginals) * topicCapPct / 100));
}
