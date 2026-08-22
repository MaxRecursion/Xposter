import { Post } from '../storage/queries.js';
import { Account, getAccount } from '../storage/accounts.js';
import { getContextStore } from '../context/enrich.js';
import type { RetrievedContextItem } from '../context/types.js';
import { logger } from '../utils/logger.js';
import { keywordMatches } from './keywords.js';
import { getVelocityConfig, isVelocityTargetingEnabled, readVelocity, roundVelocityRead } from './velocity.js';

export interface ScoreBreakdown {
  recency: number;          // 0-30: newer = higher
  topicRelevance: number;   // 0-30: more keyword matches = higher
  replyOpportunity: number; // 0-20: questions, complaints, requests
  conversationOpportunity: number; // 0-10: incomplete story, concrete complaint, genuine ask
  engagementSweet: number;  // 0-10: sweet spot (not 0, not viral)
  topicalHeat: number;       // 0-10: similarity to fresh context reporting
  accountHistory: number;    // -6 to 10: prior engagement from this author
  velocityLpm: number;       // likes/minute on the parent tweet
  velocityMeasured: boolean; // true when lpm came from two sightings, not the proxy
  reachFactor: number;       // 0.15-1.4 multiplier: is anyone still watching?
}

export interface ScoredPost {
  id: string;
  /** Composite quality score, 0-100. Gates on `min_score` as it always has. */
  score: number;
  /**
   * `score` weighted by the reach multiplier. Decides *ordering* only.
   *
   * Reach is deliberately kept out of `score`: on a quiet timeline every
   * candidate has a low like-rate, so folding the multiplier into the gate
   * would push the whole pool under `min_score` and starve the run into
   * permanent fallback. Volume should stay flat; only the aim changes.
   */
  reachScore: number;
  breakdown: ScoreBreakdown;
}

export interface ScoringSignals {
  topicalHeat?: number;
  accountHistory?: number;
}

// Signals that suggest a reply is welcome. Word boundaries prevent substring
// false positives ('how' in "show", 'fix' in "prefix", …).
const QUESTION_PATTERNS = [/\?/, /\bwhen\b/i, /\bwhere\b/i, /\bhow\b/i, /\banyone\b/i, /\bany idea/i];

const COMPLAINT_PATTERNS = [/\bterrible\b/i, /\bworst\b/i, /\bhorrible\b/i, /\bbroken\b/i, /\bfix\b/i,
  /\bfrustrated\b/i, /\bsick of\b/i];

const HELP_REQUEST_PATTERNS = [/\bhelp\b/i, /\bsuggest/i, /\brecommend/i, /\badvice\b/i];

const CONVERSATION_ASK = [/\bwhat should i\b/i, /\bshould i\b/i, /\banyone (else|know|tried)\b/i, /\bchange my mind\b/i];
const INCOMPLETE_STORY = [/\bthen\b.+\b(suddenly|today|just)\b/i, /\bstill waiting\b/i, /\bno update\b/i, /\bso far\b/i];
const CONCRETE_COMPLAINT = [/\b(road|pothole|metro|pmc|salary|rent|placement|power cut|waterlog)/i];

// English topic keyword weights
const WEIGHTED_KEYWORDS: Array<[string, number]> = [
  ['pune', 1],
  ['rain', 2], ['flood', 2],
  ['traffic', 2],
  ['waterlog', 2], ['pothole', 2], ['pmc', 1],
  ['event', 1], ['local', 1], ['metro', 1],
  ['ai', 2], ['startup', 2], ['tech', 1],
];

export function scorePost(post: Post, signals: ScoringSignals = {}): ScoredPost {
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = now - post.timestamp;

  // ── Recency (0–30) ────────────────────────────────────────────────────────
  // Full score within 30 min, linear decay to 0 at 6 hours
  const sixHours = 6 * 3600;
  const recency = Math.max(0, 30 * (1 - ageSeconds / sixHours));

  // ── Topic Relevance (0–30) ─────────────────────────────────────────────────
  let kwScore = 0;
  for (const [kw, weight] of WEIGHTED_KEYWORDS) {
    if (keywordMatches(post.text, kw)) {
      kwScore += weight;
    }
  }
  const topicRelevance = Math.min(30, kwScore * 5);

  // ── Reply Opportunity (0–20) ───────────────────────────────────────────────
  let oppScore = 0;
  if (QUESTION_PATTERNS.some((p) => p.test(post.text))) oppScore += 12;
  if (COMPLAINT_PATTERNS.some((p) => p.test(post.text))) oppScore += 8;
  if (HELP_REQUEST_PATTERNS.some((p) => p.test(post.text))) oppScore += 10;
  const replyOpportunity = Math.min(20, oppScore);

  let convScore = 0;
  if (CONVERSATION_ASK.some((p) => p.test(post.text))) convScore += 5;
  if (INCOMPLETE_STORY.some((p) => p.test(post.text))) convScore += 4;
  if (COMPLAINT_PATTERNS.some((p) => p.test(post.text)) && CONCRETE_COMPLAINT.some((p) => p.test(post.text))) {
    convScore += 4;
  }
  if (/\?\s*$/.test(post.text.trim())) convScore += 2;
  const conversationOpportunity = Math.min(10, convScore);

  // ── Engagement Sweet Spot (0–10) ──────────────────────────────────────────
  // Zero engagement = possibly irrelevant spam
  // Viral (>500 likes) = hard to stand out, skip
  const totalEngagement = post.likes + post.replies * 2 + post.retweets;
  let engScore = 0;
  if (totalEngagement >= 1 && totalEngagement <= 50) engScore = 10;
  else if (totalEngagement > 50 && totalEngagement <= 200) engScore = 6;
  else if (totalEngagement > 200 && totalEngagement <= 500) engScore = 3;
  // 0 engagement or >500: engScore stays 0
  const engagementSweet = engScore;
  const topicalHeat = clamp(signals.topicalHeat ?? 0, 0, 10);
  const accountHistory = clamp(signals.accountHistory ?? 0, -6, 10);

  // ── Reach multiplier ──────────────────────────────────────────────────────
  // Applied to the composite rather than added to it: a dead tweet should not
  // be rescued by keyword relevance, however topical it looks.
  const velocityCfg = getVelocityConfig();
  const velocity = readVelocity(
    post.likes, post.timestamp, now, velocityCfg, post.replies,
    {
      firstSeenSec: post.ingested_at,
      obs: post.obs_at != null && post.obs_likes != null
        ? { likes: post.obs_likes, at: post.obs_at }
        : null,
    },
  );
  const reachActive = isVelocityTargetingEnabled();
  const { velocityLpm, reachFactor } = roundVelocityRead(velocity);

  const breakdown: ScoreBreakdown = {
    recency: Math.round(recency * 10) / 10,
    topicRelevance: Math.round(topicRelevance * 10) / 10,
    replyOpportunity: Math.round(replyOpportunity * 10) / 10,
    conversationOpportunity: Math.round(conversationOpportunity * 10) / 10,
    engagementSweet,
    topicalHeat: Math.round(topicalHeat * 10) / 10,
    accountHistory: Math.round(accountHistory * 10) / 10,
    velocityLpm,
    velocityMeasured: velocity.lpmSource === 'observed',
    reachFactor: reachActive ? reachFactor : 1,
  };

  const base = clamp(
    breakdown.recency +
    breakdown.topicRelevance +
    breakdown.replyOpportunity +
    breakdown.conversationOpportunity +
    breakdown.engagementSweet +
    breakdown.topicalHeat +
    breakdown.accountHistory,
    0,
    100,
  );
  const reachScore = reachActive ? base * reachFactor : base;

  return {
    id: post.id,
    score: Math.round(base * 10) / 10,
    reachScore: Math.round(reachScore * 100) / 100,
    breakdown,
  };
}

export async function scorePostsWithSignals(posts: Post[]): Promise<ScoredPost[]> {
  const topicalHeat = await loadTopicalHeat(posts);
  return posts.map((post, index) => scorePost(post, {
    topicalHeat: topicalHeat[index] ?? 0,
    accountHistory: accountHistorySignal(getAccount(post.author_handle)),
  }));
}

export function topicalHeatSignal(items: RetrievedContextItem[]): number {
  if (items.length === 0) return 0;
  const best = Math.max(...items.map((item) => {
    const similarity = 1 - clamp(item.distance, 0, 1);
    return similarity * clamp(item.credibility, 0, 1);
  }));
  // Ignore weak matches, then map credible cosine similarity into a 0-10 boost.
  return Math.round(clamp((best - 0.35) / 0.55 * 10, 0, 10) * 10) / 10;
}

export function accountHistorySignal(
  account: Pick<Account, 'total_replies_sent' | 'avg_reply_score' | 'successful_replies'> & {
    author_engaged_replies?: number;
  } | null,
): number {
  if (!account || account.total_replies_sent <= 0) return 0;
  if (account.total_replies_sent >= 3 && account.successful_replies === 0) return -6;

  const successRate = account.successful_replies / Math.max(1, account.total_replies_sent);
  const scoreQuality = clamp(account.avg_reply_score / 40, 0, 1);
  const authorComeback = clamp((account.author_engaged_replies ?? 0) / Math.max(1, account.total_replies_sent), 0, 1);
  return Math.round(clamp(successRate * 5 + scoreQuality * 3 + authorComeback * 4, 0, 10) * 10) / 10;
}

/**
 * Orders candidates by reach-weighted score, so that among everything clearing
 * `min_score` we always aim at the tweet still gathering attention.
 */
export function rankCandidates(scored: ScoredPost[]): ScoredPost[] {
  return [...scored].sort((a, b) => (b.reachScore ?? b.score) - (a.reachScore ?? a.score));
}

// ── Trend scoring ─────────────────────────────────────────────────────────────

/**
 * Trend candidates need the opposite of `engagementSweet`.
 *
 * `scorePost` awards 10 points for 1-50 total engagement and 0 for anything
 * above 500 — it deliberately steers away from viral posts, which is right for
 * the home timeline where the goal is genuine conversation with small accounts.
 * Under a trending hashtag the goal is reach, so a separate profile inverts
 * that: reward absolute reach and how fast it's climbing, but penalise posts
 * already buried under thousands of replies where nobody will scroll far enough
 * to see ours.
 *
 * Kept as its own function rather than a flag on `scorePost` so the two
 * breakdowns stay separately typed and the existing scorer's pinned behaviour
 * is untouched.
 */
export interface TrendScoreBreakdown {
  reach: number;           //   0-30: absolute audience, log-scaled
  velocity: number;        //   0-25: engagement per hour
  replyWindow: number;     //   0-20: old enough to have traction, young enough to matter
  crowding: number;        // -20-0 : how buried our reply would be
  trendHeat: number;       //   0-15: freshness/rank momentum of the trend itself
  accountHistory: number;  //  -6-10: prior engagement from this author
}

export interface TrendScoringSignals {
  trendHeat?: number;
  accountHistory?: number;
}

export function scoreTrendPost(post: Post, signals: TrendScoringSignals = {}): ScoredPost {
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = Math.max(0, now - post.timestamp);
  const ageMinutes = ageSeconds / 60;
  const ageHours = Math.max(0.25, ageSeconds / 3600);

  const weighted = post.likes + post.retweets * 2 + post.replies;

  // ── Reach (0-30) ──────────────────────────────────────────────────────────
  // Log-scaled so 10k and 100k don't both saturate; 10^4.5 ≈ 32k caps it.
  const reach = clamp((Math.log10(1 + weighted) / 4.5) * 30, 0, 30);

  // ── Velocity (0-25) ───────────────────────────────────────────────────────
  // 2k likes in 40 minutes is a very different bet from 2k over three days.
  const perHour = weighted / ageHours;
  const velocity = clamp((Math.log10(1 + perHour) / 3.5) * 25, 0, 25);

  // ── Reply window (0-20) ───────────────────────────────────────────────────
  // Under 10 min the post may never take off at all; past ~6h the thread is done.
  let replyWindow: number;
  if (ageMinutes < 10) replyWindow = 8;
  else if (ageMinutes <= 180) replyWindow = 20;
  else if (ageMinutes <= 360) replyWindow = 10;
  else if (ageMinutes <= 720) replyWindow = 4;
  else replyWindow = 0;

  // ── Crowding (-20-0) ──────────────────────────────────────────────────────
  // Paired with reach, the optimum becomes "large audience, not yet buried".
  const crowding = -clamp((post.replies / 150) * 20, 0, 20);

  const trendHeat = clamp(signals.trendHeat ?? 0, 0, 15);
  const accountHistory = clamp(signals.accountHistory ?? 0, -6, 10);

  const breakdown: TrendScoreBreakdown = {
    reach: round1(reach),
    velocity: round1(velocity),
    replyWindow,
    crowding: round1(crowding),
    trendHeat: round1(trendHeat),
    accountHistory: round1(accountHistory),
  };

  const score = clamp(
    breakdown.reach + breakdown.velocity + breakdown.replyWindow
    + breakdown.crowding + breakdown.trendHeat + breakdown.accountHistory,
    0,
    100,
  );

  // The trend profile already scores velocity and reply-window directly, so its
  // composite needs no separate reach weighting.
  return {
    id: post.id,
    score: round1(score),
    reachScore: round1(score),
    breakdown: breakdown as unknown as ScoreBreakdown,
  };
}

export function scoreTrendPosts(posts: Post[], trendHeat: number): ScoredPost[] {
  return posts.map((post) => scoreTrendPost(post, {
    trendHeat,
    accountHistory: accountHistorySignal(getAccount(post.author_handle)),
  }));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

async function loadTopicalHeat(posts: Post[]): Promise<number[]> {
  if (posts.length === 0) return [];
  const store = getContextStore();
  if (!store) return posts.map(() => 0);

  try {
    const matches = await store.semanticSearchMany(
      posts.map((post) => post.text),
      { k: 3, maxAgeSeconds: 48 * 3600 },
    );
    return matches.map(topicalHeatSignal);
  } catch (err) {
    logger.warn('Candidate topical-heat lookup failed; using base scores', { err: String(err) });
    return posts.map(() => 0);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
